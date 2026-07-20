/**
 * Child worker: crawl one URL with bounded env, write JSON result, exit.
 * Avoid POLICY_EXHAUSTIVE (would launch Playwright at end and unbounded PDFs).
 */
process.env.POLICY_EXHAUSTIVE = "0";
process.env.OCR_ENABLED = "0";
process.env.SCAN_FAST = "1";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.env.INSECURE_EXTERNAL_TLS = "true";

const url = process.argv[2];
const outPath = process.argv[3];
if (!url || !outPath) {
  console.error("usage: staging-crawl-one.mjs <url> <out.json>");
  process.exit(2);
}

const { writeFileSync } = await import("node:fs");

function writeFail(err) {
  writeFileSync(
    outPath,
    JSON.stringify({
      ok: false,
      error: err,
      text: "",
      pagesVisited: [],
      policyExhaustive: false,
      foundRelevantPage: false,
      needsOcrReview: false,
    })
  );
}

const origFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init = {}) => {
  const u = typeof input === "string" ? input : input?.url || String(input);
  // Skip PDFs and heavy binary; OCR proved via fixture in parent harness
  if (/\.pdf(?:$|\?|#)/i.test(u) || /\.(zip|docx?|xlsx?|pptx?)(?:$|\?|#)/i.test(u)) {
    return Promise.reject(new Error("staging_skip_binary"));
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5_000);
  if (init.signal) {
    if (init.signal.aborted) ctrl.abort();
    else init.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  return origFetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(t));
};

console.error(`[staging-crawl-one] start ${url}`);
const t0 = Date.now();

try {
  const { crawlSite } = await import("../src/lib/sanita/crawler.ts");
  const crawl = await crawlSite(url);
  const slim = {
    ok: Boolean(crawl?.ok),
    error: crawl?.error || null,
    text: (crawl?.text || "").slice(0, 80_000),
    policyText: (crawl?.policyText || "").slice(0, 40_000),
    pagesVisited: crawl?.pagesVisited || [],
    policyExhaustive: Boolean(crawl?.policyExhaustive),
    foundRelevantPage: Boolean(crawl?.foundRelevantPage),
    needsOcrReview: Boolean(crawl?.needsOcrReview),
    policyPdfAnalysis: crawl?.policyPdfAnalysis || null,
    completeness: crawl?.completeness || null,
    elapsedMs: Date.now() - t0,
  };
  writeFileSync(outPath, JSON.stringify(slim));
  console.error(`[staging-crawl-one] done ok=${slim.ok} pages=${slim.pagesVisited.length} ms=${slim.elapsedMs}`);
  process.exit(crawl?.ok ? 0 : 1);
} catch (e) {
  writeFail(e instanceof Error ? e.message : String(e));
  console.error(`[staging-crawl-one] fail ${e}`);
  process.exit(1);
}
