/**
 * Discovery (Tavily/snippet/blog/directory) → solo candidati, mai verdette terminali.
 */
export type DiscoverySourceClass =
  | "OFFICIAL_SITE"
  | "GROUP_OFFICIAL"
  | "ASL_INSTITUTIONAL"
  | "SEARCH_DISCOVERY"
  | "BLOG_ARTICLE"
  | "BROKER_COMPARISON"
  | "DIRECTORY"
  | "SNIPPET"
  | "UNKNOWN";

const NON_TERMINAL: ReadonlySet<DiscoverySourceClass> = new Set([
  "SEARCH_DISCOVERY",
  "BLOG_ARTICLE",
  "BROKER_COMPARISON",
  "DIRECTORY",
  "SNIPPET",
  "UNKNOWN",
]);

/** Fonti che non possono sostenere PUBLISHED/HOT terminali. */
export function discoveryBlocksTerminalVerdict(source: DiscoverySourceClass): boolean {
  return NON_TERMINAL.has(source);
}

export function classifyUrlSource(url: string | null | undefined): DiscoverySourceClass {
  if (!url) return "UNKNOWN";
  const u = url.toLowerCase();
  if (/tavily|google\.|bing\.|duckduckgo|yahoo\./i.test(u)) return "SEARCH_DISCOVERY";
  if (/blog|wordpress|medium\.com|substack/i.test(u)) return "BLOG_ARTICLE";
  if (/broker|assicur|compar|facile\.it|segugio|prima\.it/i.test(u)) return "BROKER_COMPARISON";
  if (/paginegialle|paginebianche|yelp|cylex|misterimprese|tripadvisor/i.test(u)) return "DIRECTORY";
  if (/aslnapoli|aslnapo|aulss|ulss|regione\.(campania|veneto)|salute\.gov/i.test(u)) {
    return "ASL_INSTITUTIONAL";
  }
  return "UNKNOWN";
}

/**
 * Tavily / ricerca web: al massimo REVIEW + candidati URL.
 * Mai PUBLISHED diretto da snippet.
 */
export function terminalVerdictFromDiscovery(policyFoundInSnippet: boolean): "REVIEW" {
  void policyFoundInSnippet;
  return "REVIEW";
}
