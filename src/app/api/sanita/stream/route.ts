import type { Region } from "@/lib/sanita/discovery";
import type { ScanStreamInput } from "@/lib/sanita/scan-stream";
import {
  getScanEngineUrl,
  HETZNER_SCAN_ENGINE,
  isVercelUiHost,
} from "@/lib/sanita/scan-engine-url";

export const runtime = "nodejs";
export const maxDuration = 300;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
} as const;

function sseResponse(message: string, event: "error" | "progress" = "error") {
  return new Response(`event: ${event}\ndata: ${JSON.stringify({ message })}\n\n`, {
    headers: SSE_HEADERS,
  });
}

/** Vercel UI → inoltra la scansione al server Hetzner dove gira Playwright. */
async function proxyToScanEngine(rawBody: string, base: string): Promise<Response | null> {
  const url = base.trim();
  if (!url) return null;

  try {
    const upstream = await fetch(`${url}/api/sanita/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rawBody,
    });

    if (!upstream.ok || !upstream.body) return null;

    return new Response(upstream.body, { headers: SSE_HEADERS });
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  let body: ScanStreamInput;
  try {
    body = JSON.parse(rawBody) as ScanStreamInput;
  } catch {
    return sseResponse("Richiesta non valida.");
  }

  if (!body.region || !["Veneto", "Campania"].includes(body.region)) {
    return new Response(JSON.stringify({ success: false, error: "Regione non supportata." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Solo la UI Vercel fa proxy. Hetzner esegue Playwright in locale (SCAN_ENGINE_LOCAL=1).
  if (isVercelUiHost()) {
    const bases = [getScanEngineUrl(), HETZNER_SCAN_ENGINE].filter(
      (v, i, a) => v && a.indexOf(v) === i
    );
    for (const base of bases) {
      const proxied = await proxyToScanEngine(rawBody, base);
      if (proxied) return proxied;
    }
    return sseResponse(
      "Motore scansione Hetzner non raggiungibile. Verifica che il server sia online su 168.119.253.47:3000."
    );
  }

  const { runStreamingScan } = await import("@/lib/sanita/scan-stream");
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        await runStreamingScan({ ...body, region: body.region as Region }, send);
      } catch (error) {
        console.error("Stream Sanità:", error);
        send("error", {
          message: error instanceof Error ? error.message : "Errore interno durante la scansione",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
