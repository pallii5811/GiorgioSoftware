import { runStreamingScan, type ScanStreamInput } from "@/lib/sanita/scan-stream";
import type { Region } from "@/lib/sanita/discovery";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  const body = (await req.json()) as ScanStreamInput;

  if (!body.region || !["Veneto", "Campania"].includes(body.region)) {
    return new Response(JSON.stringify({ success: false, error: "Regione non supportata." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

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

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
