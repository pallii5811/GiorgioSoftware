import type { Region } from "@/lib/sanita/discovery";
import type { ScanStreamInput } from "@/lib/sanita/scan-stream";
import { getScanEngineUrl, HETZNER_SCAN_ENGINE } from "@/lib/sanita/scan-engine-url";

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
async function proxyToScanEngine(rawBody: string, baseOverride?: string) {
  const base = (baseOverride || getScanEngineUrl()).trim();
  if (!base) return null;

  try {
    const upstream = await fetch(`${base}/api/sanita/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rawBody,
    });

    if (!upstream.ok || !upstream.body) {
      return sseResponse(
        `Motore scansione non raggiungibile (${upstream.status}). Verifica che l'app sia avviata su Hetzner.`
      );
    }

    return new Response(upstream.body, { headers: SSE_HEADERS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return sseResponse(`Motore scansione non raggiungibile: ${msg.slice(0, 120)}`);
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

  let proxied = await proxyToScanEngine(rawBody);
  if (!proxied && process.env.VERCEL_ENV === "production") {
    proxied = await proxyToScanEngine(rawBody, HETZNER_SCAN_ENGINE);
  }
  if (proxied) return proxied;

  if (process.env.VERCEL) {
    return sseResponse(
      "La scansione richiede Playwright (Chrome) e non può girare su Vercel. " +
        "Avvia l'app su Hetzner oppure imposta SCAN_ENGINE_URL nelle variabili Vercel."
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
