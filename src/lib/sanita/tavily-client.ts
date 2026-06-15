import { tavily } from "@tavily/core";

let cached: ReturnType<typeof tavily> | null | undefined;

export function getTavilyClient(): ReturnType<typeof tavily> | null {
  if (cached !== undefined) return cached;
  const key = process.env.TAVILY_API_KEY?.trim();
  cached = key ? tavily({ apiKey: key }) : null;
  return cached;
}

export function isTavilyAvailable(): boolean {
  return getTavilyClient() !== null;
}

export interface TavilyHit {
  content: string;
  url: string;
}

export async function tavilySearch(
  query: string,
  opts: { maxResults?: number; depth?: "basic" | "advanced" } = {}
): Promise<TavilyHit[]> {
  const tvly = getTavilyClient();
  if (!tvly) return [];
  try {
    const res = await tvly.search(query, {
      searchDepth: opts.depth ?? "basic",
      maxResults: opts.maxResults ?? 5,
      includeAnswer: false,
    });
    return (res.results || []).map((r: { content?: string; snippet?: string; url?: string }) => ({
      content: String(r.content || r.snippet || ""),
      url: String(r.url || ""),
    }));
  } catch {
    return [];
  }
}
