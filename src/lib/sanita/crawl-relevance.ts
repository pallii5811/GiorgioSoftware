/**
 * Crawl URL relevance — commercial completeness uses critical+relevant only.
 * Discovered HTML without insurance/institutional signal defaults to low
 * (prevents news/blog/services flood from blocking frontier close or false CRAWL_CAP).
 */
export type CrawlRelevance = "critical" | "relevant" | "low";

const CRITICAL_RE =
  /trasparen|polizz|assicur|amministraz|gelli|rischio|rc[to]\b|rco\b|parm|pars|massimale|copertura|note-legali|scheda[-_]?di[-_]?polizza|rc\s*sanitar/i;

const RELEVANT_RE =
  /(^|\/)(chi[-_]?siamo|la[-_]?struttura|struttura|contatti|contatto|privacy|cookie(?:-?policy)?|note[-_]?legali|home|index|chi[-_]?e|about)(\/|$|\.|-)/i;

const LOW_RE =
  /news|blog|comunicat|notizi|medico|dott\.|prestazion|servizi|reparto|specialist|gallery|media|evento|pagina|page[=/_\-]\d|wp-content|attachment|categoria|tag\/|feed|rss|video|foto|immagine|prenota|agenda/i;

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return String(url || "").toLowerCase();
  }
}

/**
 * @param discoverySource seed|seed_guess|extra|html-link|sitemap|playwright|…
 */
export function classifyUrlRelevance(
  url: string,
  opts?: { discoverySource?: string | null }
): CrawlRelevance {
  const src = String(opts?.discoverySource || "");
  const path = pathOf(url);
  const isPdf = /\.pdf(?:$|\?|#)/i.test(url);
  const hay = `${url} ${path}`;

  if (CRITICAL_RE.test(hay)) return "critical";

  if (isPdf) {
    // Non-policy PDFs stay low — do not inflate commercial completeness.
    return "low";
  }

  // Explicit seeds / extras: institutional surface is relevant even without keywords.
  if (src === "seed" || src === "seed_guess" || src === "extra") {
    if (LOW_RE.test(path) && !RELEVANT_RE.test(path) && path !== "/" && path !== "") {
      // e.g. /servizi seed — keep as relevant because it is an explicit seed (spec).
      return "relevant";
    }
    return "relevant";
  }

  if (path === "/" || path === "" || RELEVANT_RE.test(path)) return "relevant";
  if (LOW_RE.test(hay)) return "low";

  // Sitemap / html-link / playwright discoveries without signal → low (not relevant).
  if (
    src === "html-link" ||
    src === "playwright" ||
    src === "playwright_xhr" ||
    src === "sitemap" ||
    src === "robots" ||
    src.startsWith("sitemap")
  ) {
    return "low";
  }

  return "low";
}
