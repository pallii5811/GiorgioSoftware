export type SseHandler = (event: string, data: Record<string, unknown>) => void;

function streamUrl() {
  const base = process.env.NEXT_PUBLIC_SCAN_ENGINE_URL?.replace(/\/$/, "");
  if (!base) return "/api/sanita/stream";
  if (typeof window !== "undefined" && window.location.protocol === "https:" && base.startsWith("http:")) {
    return "/api/sanita/stream";
  }
  return `${base}/api/sanita/stream`;
}

/** Consuma una risposta SSE da POST /api/sanita/stream. */
export async function consumeSanitaScanStream(
  body: Record<string, unknown>,
  onEvent: SseHandler,
  signal?: AbortSignal
): Promise<"complete" | "paused" | "error"> {
  let res: Response;
  const timeoutMs = Number(process.env.SCAN_SSE_ROUND_MS) || 12 * 60_000;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    res = await fetch(streamUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ?? abort.signal,
    });
  } catch {
    clearTimeout(timer);
    return "paused";
  }
  clearTimeout(timer);

  if (!res.ok || !res.body) {
    let detail = `HTTP ${res.status}`;
    try {
      const text = await res.text();
      if (text.includes("event: error")) {
        const m = text.match(/data: (\{.*\})/);
        if (m) detail = JSON.parse(m[1]).message ?? detail;
      }
    } catch {
      /* ignore */
    }
    onEvent("error", { message: detail });
    if (res.status >= 500 || res.status === 0) return "paused";
    return "error";
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let outcome: "complete" | "paused" | "error" = "paused";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        const lines = chunk.split("\n");
        let event = "message";
        let dataLine = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) event = line.slice(7).trim();
          else if (line.startsWith("data: ")) dataLine = line.slice(6);
        }
        if (!dataLine) continue;
        try {
          const data = JSON.parse(dataLine) as Record<string, unknown>;
          onEvent(event, data);
          if (event === "complete") outcome = "complete";
          if (event === "error") outcome = "error";
        } catch {
          /* ignore malformed */
        }
      }
    }
  } catch {
    return "paused";
  }

  return outcome;
}
