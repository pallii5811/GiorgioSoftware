export type SseHandler = (event: string, data: Record<string, unknown>) => void;

/** Consuma una risposta SSE da POST /api/sanita/stream. */
export async function consumeSanitaScanStream(
  body: Record<string, unknown>,
  onEvent: SseHandler,
  signal?: AbortSignal
): Promise<"complete" | "paused" | "error"> {
  const res = await fetch("/api/sanita/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    onEvent("error", { message: `HTTP ${res.status}` });
    return "error";
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let outcome: "complete" | "paused" | "error" = "paused";

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

  return outcome;
}
