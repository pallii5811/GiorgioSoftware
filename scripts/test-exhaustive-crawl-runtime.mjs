import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

process.env.CRAWL_REQUIRE_EXHAUSTIVE_SITE = "1";
process.env.CRAWL_RENDER_EVERY_HTML = "1";
process.env.CRAWL_HTML_URL_CAP = "0";
process.env.PER_HOST_DELAY_MS = "0";

const {
  openFrontierStore,
  closeFrontierStore,
  createCrawlRun,
  upsertFrontierNode,
  transitionFrontierNode,
  setCrawlRunFlags,
  releaseWorkerLock,
  deriveExhaustiveSiteCoverage,
  listNodes,
} = await import("../src/lib/sanita/frontier-store.ts");
const { runCrawlUntilSettled } = await import(
  "../src/lib/sanita/crawl-slice-runner.ts"
);

const requests = [];
const server = http.createServer((req, res) => {
  const url = req.url || "/";
  requests.push(url);
  if (url === "/") {
    res.setHeader("content-type", "text/html");
    res.end(`
      <html><body>
        <a href="/ordinary-page">Pagina ordinaria</a>
        <script src="/assets/app.js"></script>
      </body></html>
    `);
    return;
  }
  if (url === "/ordinary-page") {
    res.setHeader("content-type", "text/html");
    res.end(`<html><body><p>Informazioni generali della struttura.</p></body></html>`);
    return;
  }
  if (url === "/assets/app.js") {
    res.setHeader("content-type", "application/javascript");
    res.end(`fetch("/api/site-data.json").catch(() => {});`);
    return;
  }
  if (url === "/api/site-data.json") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ section: "informazioni", items: [] }));
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const website = `http://127.0.0.1:${address.port}/`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exhaustive-runtime-"));

try {
  openFrontierStore(path.join(tmp, "frontier.sqlite"));
  const leadId = "runtime-lead";
  const runId = "runtime-run";
  const { crawlRunId } = createCrawlRun({ leadId, runId, workerId: "setup" });
  const seed = upsertFrontierNode({
    crawlRunId,
    canonicalUrl: website,
    resourceType: "html",
    relevance: "relevant",
    discoverySource: "seed",
  });
  transitionFrontierNode(seed.id, "QUEUED");
  setCrawlRunFlags(crawlRunId, {
    identityVerified: true,
    scopeVerified: true,
    sitemapStatus: "NOT_PRESENT",
  });
  releaseWorkerLock(crawlRunId);

  const settled = await runCrawlUntilSettled({
    leadId,
    runId,
    website,
    workerId: "runtime-test",
    discoverLinks: true,
    enablePlaywright: true,
    maxSlices: 8,
    budget: {
      sliceBudgetMs: 90_000,
      runMaxWallClockMs: 240_000,
      httpRequestTimeoutMs: 5_000,
      browserNavigationTimeoutMs: 15_000,
      pdfFetchTimeoutMs: 10_000,
      ocrTimeoutMs: 30_000,
      maxUrlRetries: 2,
      maxBrowserRetries: 2,
      maxDocumentRetries: 2,
      perHostConcurrency: 1,
      perHostDelayMs: 0,
      maxHtmlPerSlice: 20,
    },
  });
  const coverage = deriveExhaustiveSiteCoverage(settled.crawlRunId);
  const nodes = listNodes(settled.crawlRunId);
  const browserUnavailable = nodes.some((node) =>
    /PLAYWRIGHT_NO_CHROMIUM/i.test(node.lastError || "")
  );
  if (browserUnavailable) {
    console.log(
      JSON.stringify({
        suite: "exhaustive-crawl-runtime",
        exitCode: 0,
        skipped: 1,
        reason: "local Chromium unavailable; remote canary required",
      })
    );
  } else {
    assert.equal(
      settled.final.outcome,
      "RUN_COMPLETED",
      JSON.stringify({ slices: settled.slices, coverage, nodes })
    );
    assert.equal(coverage.ok, true, coverage.reasons.join(","));
    assert.ok(requests.includes("/ordinary-page"), "ordinary non-keyword page was crawled");
    assert.ok(requests.includes("/assets/app.js"), "same-site JavaScript was crawled");
    assert.ok(requests.includes("/api/site-data.json"), "JSON endpoint was crawled");
    console.log(
      JSON.stringify({
        suite: "exhaustive-crawl-runtime",
        exitCode: 0,
        coverage,
        requested: [...new Set(requests)],
      })
    );
  }
} finally {
  closeFrontierStore();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}
