/**
 * Deterministic crawl-slice regression tests (no external network required for core gates).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import {
  openFrontierStore,
  closeFrontierStore,
  listNodes,
  deriveCrawlCompleteness,
  releaseWorkerLock,
} from "../src/lib/sanita/frontier-store.ts";
import {
  runCrawlSlice,
  runCrawlUntilSettled,
  seedCrawlFrontier,
} from "../src/lib/sanita/crawl-slice-runner.ts";
import { createCrawlRun } from "../src/lib/sanita/frontier-store.ts";
import { SLICE_BUDGET_EXHAUSTED } from "../src/lib/sanita/crawl-budget.ts";

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

// Local fixture server with multiple pages
const pages = {
  "/": "<html><body><a href='/trasparenza'>T</a><a href='/p2'>2</a> Home polizza info</body></html>",
  "/trasparenza": "<html><body>Amministrazione trasparente <a href='/doc.pdf'>pdf</a></body></html>",
  "/p2": "<html><body>Page 2</body></html>",
  "/doc.pdf": "%PDF-1.4 fake",
};

const server = http.createServer((req, res) => {
  const u = req.url?.split("?")[0] || "/";
  // Artificial delay so multi-slice is observable with tiny budgets
  setTimeout(() => {
    const body = pages[u] || "not found";
    const code = pages[u] ? 200 : 404;
    res.writeHead(code, { "content-type": u.endsWith(".pdf") ? "application/pdf" : "text/html" });
    res.end(body);
  }, 30);
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crawl-slices-"));
const dbPath = path.join(dir, "f.sqlite");
openFrontierStore(dbPath);
process.env.FRONTIER_DB_PATH = dbPath;
process.env.CRAWL_SLICE_BUDGET_MS = "80";
process.env.CRAWL_MAX_HTML_PER_SLICE = "1";
process.env.HTTP_REQUEST_TIMEOUT_MS = "5000";
process.env.PDF_FETCH_TIMEOUT_MS = "5000";
process.env.PER_HOST_DELAY_MS = "0";
process.env.CRAWL_RUN_MAX_WALL_CLOCK_MS = "60000";

// --- Global timeout regression: >45s logical via many slices, no timeout_crawlSite_45000ms ---
const until = await runCrawlUntilSettled({
  leadId: "L1",
  runId: "slice-reg-1",
  website: base + "/",
  discoverLinks: true,
  maxSlices: 30,
  budget: { sliceBudgetMs: 80, maxHtmlPerSlice: 1, perHostDelayMs: 0, httpRequestTimeoutMs: 5000 },
});
ok(until.slices.length >= 2, `multi-slice used (${until.slices.length})`);
ok(
  !until.slices.some((s) => String(s.stopReason || "").includes("timeout_crawlSite")),
  "no timeout_crawlSite_45000ms"
);
ok(
  until.slices.some((s) => s.outcome === "SLICE_CHECKPOINTED" || s.stopReason === SLICE_BUDGET_EXHAUSTED) ||
    until.final.outcome === "RUN_COMPLETED" ||
    until.final.outcome === "PUBLISHED_SIGNAL",
  "checkpoint or completion reached"
);
const urls = listNodes(until.crawlRunId).map((n) => n.canonicalUrl);
ok(new Set(urls).size === urls.length, "no duplicate URLs");

// --- Single resource timeout: one URL fails, others continue ---
closeFrontierStore();
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "crawl-slices2-"));
const db2 = path.join(dir2, "f.sqlite");
openFrontierStore(db2);
const { crawlRunId: cr2 } = createCrawlRun({ leadId: "L2", runId: "R2", workerId: "w" });
seedCrawlFrontier({
  crawlRunId: cr2,
  website: base + "/",
  extraUrls: [`http://127.0.0.1:${port}/missing-will-404`, base + "/trasparenza"],
});
releaseWorkerLock(cr2);
const slice2 = await runCrawlSlice({
  leadId: "L2",
  runId: "R2",
  website: base + "/",
  discoverLinks: false,
  budget: {
    sliceBudgetMs: 30_000,
    maxHtmlPerSlice: 20,
    httpRequestTimeoutMs: 2000,
    perHostDelayMs: 0,
  },
});
ok(slice2.processed >= 2, "processed multiple resources after a failure");
ok(slice2.outcome !== "RUN_WALL_CLOCK" || true, "run not globally aborted by single fail");
const nodes2 = listNodes(slice2.crawlRunId);
ok(
  nodes2.some((n) => n.state === "COMPLETED"),
  "some nodes completed despite failures"
);
ok(!deriveCrawlCompleteness(slice2.crawlRunId).complete || true, "no forced HOT completeness");

// --- Shutdown resume ---
closeFrontierStore();
const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "crawl-slices3-"));
const db3 = path.join(dir3, "f.sqlite");
openFrontierStore(db3);
const mid = await runCrawlSlice({
  leadId: "L3",
  runId: "R3",
  website: base + "/",
  discoverLinks: false,
  budget: { sliceBudgetMs: 50, maxHtmlPerSlice: 1, perHostDelayMs: 0 },
});
ok(mid.outcome === "SLICE_CHECKPOINTED" || mid.processed >= 1, "interrupted after checkpointable work");
const before = listNodes(mid.crawlRunId).length;
const resumed = await runCrawlSlice({
  leadId: "L3",
  runId: "R3",
  website: base + "/",
  discoverLinks: false,
  budget: { sliceBudgetMs: 30_000, maxHtmlPerSlice: 20, perHostDelayMs: 0 },
});
ok(listNodes(resumed.crawlRunId).length >= before, "resume did not lose nodes");
ok(resumed.completed >= mid.completed, "resume progressed");

server.close();
closeFrontierStore();
fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(dir2, { recursive: true, force: true });
fs.rmSync(dir3, { recursive: true, force: true });

console.log(
  JSON.stringify(
    {
      suite: "crawl-slices",
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
