/**
 * Staging runtime smoke: budgets + no monolithic 45s error string in slice runner.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { openFrontierStore, closeFrontierStore, deriveCrawlCompleteness } from "../src/lib/sanita/frontier-store.ts";
import { runCrawlUntilSettled } from "../src/lib/sanita/crawl-slice-runner.ts";
import { readCrawlBudgetConfig } from "../src/lib/sanita/crawl-budget.ts";

const start = Date.now();
let pass = 0;
let fail = 0;
function ok(c, m) {
  if (c) {
    pass++;
    console.log(`  ✓ ${m}`);
  } else {
    fail++;
    console.error(`  ✗ ${m}`);
  }
}

const cfg = readCrawlBudgetConfig();
ok(cfg.sliceBudgetMs > 45_000, "slice budget > 45s (not monolithic lead kill)");
ok(cfg.runMaxWallClockMs >= 600_000 || cfg.runMaxWallClockMs > 0, "wall clock configurable");

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<html><body>Page ${req.url} — no polizza here <a href='/a'>a</a><a href='/b'>b</a></body></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "staging-runtime-"));
openFrontierStore(path.join(dir, "f.sqlite"));

const { slices, final } = await runCrawlUntilSettled({
  leadId: "sr1",
  runId: "staging-runtime-smoke",
  website: `http://127.0.0.1:${port}/`,
  discoverLinks: false,
  maxSlices: 5,
  budget: { sliceBudgetMs: 100, maxHtmlPerSlice: 1, perHostDelayMs: 0, httpRequestTimeoutMs: 3000 },
});
ok(slices.length >= 1, "at least one slice");
ok(!JSON.stringify(slices).includes("timeout_crawlSite_45000"), "no timeout_crawlSite_45000ms");
ok(
  slices.some((s) => s.outcome === "SLICE_CHECKPOINTED") || final.outcome === "RUN_COMPLETED",
  "checkpoint or complete"
);
ok(typeof deriveCrawlCompleteness(final.crawlRunId).complete === "boolean", "completeness from DB");

server.close();
closeFrontierStore();
fs.rmSync(dir, { recursive: true, force: true });

console.log(
  JSON.stringify(
    {
      suite: "staging-runtime",
      exitCode: fail === 0 ? 0 : 1,
      durationMs: Date.now() - start,
      pass,
      fail,
      skipped: 0,
    },
    null,
    2
  )
);
process.exit(fail === 0 ? 0 : 1);
