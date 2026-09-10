const start = new URL(process.argv[2]);
const origin = start.origin;
const headers = { "user-agent": "Mozilla/5.0 (compatible; giorgio-policy-audit/1.0)" };
const policyTerms = /\b(?:polizz\w*|assicur\w*|rct|rco|rc\s+professionale|responsabilit[aà]\s+civile|legge\s+gelli)\b/giu;

async function get(url) {
  const response = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(30000) });
  return { url: response.url, type: response.headers.get("content-type") || "", text: await response.text() };
}

const sitemapQueue = [new URL("/sitemap.xml", origin).href, new URL("/wp-sitemap.xml", origin).href];
const seenSitemaps = new Set();
const pages = new Set([start.href]);
while (sitemapQueue.length && seenSitemaps.size < 100) {
  const sitemap = sitemapQueue.shift();
  if (seenSitemaps.has(sitemap)) continue;
  seenSitemaps.add(sitemap);
  try {
    const { text } = await get(sitemap);
    for (const match of text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/giu)) {
      const value = match[1].replaceAll("&amp;", "&");
      if (/\.xml(?:\?|$)/iu.test(value)) sitemapQueue.push(value);
      else if (value.startsWith(origin) && pages.size < 1000) pages.add(value);
    }
  } catch {
    // Missing sitemap variants are expected.
  }
}

const findings = [];
for (const page of pages) {
  try {
    const result = await get(page);
    if (!/text\/html|application\/xhtml\+xml/iu.test(result.type)) continue;
    const body = result.text
      .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
      .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/giu, " ")
      .replace(/&amp;/giu, "&")
      .replace(/\s+/g, " ")
      .trim();
    const matches = [...body.matchAll(policyTerms)];
    const policyLinks = [...result.text.matchAll(/href=["']([^"']*(?:polizz|assicur|rct|rco|gelli)[^"']*)["']/giu)]
      .map((match) => match[1]);
    if (!matches.length && !policyLinks.length) continue;
    findings.push({
      page: result.url,
      policyLinks: [...new Set(policyLinks)].slice(0, 20),
      snippets: matches.slice(0, 10).map((match) => {
        const at = match.index || 0;
        return body.slice(Math.max(0, at - 180), Math.min(body.length, at + match[0].length + 260));
      }),
    });
  } catch (error) {
    findings.push({ page, error: String(error?.message || error) });
  }
}

console.log(JSON.stringify({ origin, sitemapCount: seenSitemaps.size, pageCount: pages.size, findings }, null, 2));
