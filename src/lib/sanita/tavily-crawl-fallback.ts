/**
 * Quando il crawl diretto fallisce (403 WAF datacenter), usa Tavily per leggere
 * contenuto indicizzato del sito — IP residenziale lato Tavily.
 */
import { analyzePolicy, type PolicyAnalysis } from "@/lib/sanita/detector";
import { isTavilyAvailable, tavilySearch } from "@/lib/sanita/tavily-client";

export type TavilySiteFallback = {
  corpus: string;
  urls: string[];
  policyAnalysis: PolicyAnalysis;
};

export async function tavilyFallbackForBlockedSite(
  website: string,
  companyName: string
): Promise<TavilySiteFallback | null> {
  if (!isTavilyAvailable()) return null;

  let host: string;
  try {
    host = new URL(website.startsWith("http") ? website : `https://${website}`).hostname.replace(
      /^www\./i,
      ""
    );
  } catch {
    return null;
  }

  const base = companyName.replace(/\s+/g, " ").trim().slice(0, 60);
  const queries = [
    `site:${host} polizza responsabilità civile assicurazione RCT`,
    `site:${host} amministrazione trasparente assicurazione`,
    `"${base}" site:${host} polizza Gelli`,
  ];

  const hits = (
    await Promise.all(
      queries.map((q) => tavilySearch(q, { maxResults: 8, depth: "advanced" }))
    )
  ).flat();

  const byUrl = new Map<string, string>();
  for (const h of hits) {
    if (!h.url || !h.content?.trim()) continue;
    if (!h.url.includes(host)) continue;
    byUrl.set(h.url, `${byUrl.get(h.url) ?? ""}\n${h.content}`.trim());
  }

  const urls = [...byUrl.keys()];
  const corpus = urls.map((u) => `${byUrl.get(u)} ${u}`).join("\n");
  if (corpus.length < 120) return null;

  return {
    corpus,
    urls,
    policyAnalysis: analyzePolicy(corpus),
  };
}
