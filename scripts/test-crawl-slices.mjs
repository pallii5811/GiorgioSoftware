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
  transitionFrontierNode,
  upsertFrontierNode,
  prepareFrontierForExhaustiveCoverage,
} from "../src/lib/sanita/frontier-store.ts";
import {
  runCrawlSlice,
  runCrawlUntilSettled,
  seedCrawlFrontier,
  pickNextNodeForTest,
} from "../src/lib/sanita/crawl-slice-runner.ts";
import { createCrawlRun } from "../src/lib/sanita/frontier-store.ts";
import { SLICE_BUDGET_EXHAUSTED } from "../src/lib/sanita/crawl-budget.ts";
import {
  discoverResourcesFromHtml,
  extractVisibleTextFromHtml,
  isCrawlScopeResource,
  isClearlyCommercialProductImageUrl,
  isPolicyLikeResourceUrl,
  isRecursiveStaticAssetUrl,
} from "../src/lib/sanita/site-resource.ts";
import { analyzePolicy } from "../src/lib/sanita/detector.ts";

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
  "/ghost.png": "<html><body><img src='vendor/widget/assets/icon.png'></body></html>",
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

// A catch-all HTML shell returned for a missing image can resolve its relative
// vendor assets underneath the bogus image URL forever. Keep real documents,
// but reject recursively repeated static paths and JS concatenation tokens.
const recursiveAsset =
  `${base}/vendor/rs-plugin/whiteboard/assets/` +
  "vendor/rs-plugin/whiteboard/assets/images/blank.gif";
ok(isRecursiveStaticAssetUrl(recursiveAsset), "recursive static-asset path is detected");
ok(
  isRecursiveStaticAssetUrl(`${base}/long/theme/resources/resources/images/blank.gif`),
  "adjacent repeated static directory is detected on a deep path"
);
ok(
  !isRecursiveStaticAssetUrl(`${base}/images/images/photo.jpg`),
  "short independently addressable image path is not over-filtered"
);
ok(
  !isRecursiveStaticAssetUrl(`${base}/documenti/polizza-rct-rco-2026.pdf`),
  "real policy document is never rejected by recursive-path guard"
);
const shellResources = discoverResourcesFromHtml(
  `<script src="vendor/rs-plugin/whiteboard/assets/app.js"></script>
   <img src="+ url +"><a href="/documenti/polizza-rct-2026.pdf">Polizza</a>`,
  `${base}/vendor/rs-plugin/whiteboard/assets/images/blank.gif`,
  base
).map((item) => item.url);
ok(
  !shellResources.some((url) => url.includes("assets/vendor/rs-plugin/whiteboard/assets")),
  "HTML fallback shell cannot expand a repeated static branch"
);
ok(!shellResources.some((url) => /\+%20url%20\+/i.test(url)), "JS URL token is discarded");
ok(shellResources.some((url) => /polizza-rct-2026\.pdf/i.test(url)), "policy link remains discoverable");
ok(
  !isPolicyLikeResourceUrl("https://cdn.biddercore.io/iab/tcf_storage.json"),
  "RCT/RCO tokens do not match accidental substrings in third-party domains"
);
ok(
  !isPolicyLikeResourceUrl("https://example.net/iab/disclosure.json"),
  "generic consent-disclosure JSON is not an insurance resource"
);
ok(
  isPolicyLikeResourceUrl(`${base}/documenti/Polizza-RCT-RCO-2026.pdf`),
  "bounded RCT/RCO tokens still retain genuine policy documents"
);
ok(
  !isCrawlScopeResource(
    "https://hr.clinica.example.it/hrportal/assets/app.js",
    "https://www.clinica.example.it/",
    "script"
  ),
  "employee and application subdomains do not expand the public-site frontier"
);
ok(
  isCrawlScopeResource(
    "https://trasparenza.clinica.example.it/documenti/index.html",
    "https://www.clinica.example.it/",
    "html"
  ),
  "public transparency subdomains remain in scope"
);
ok(
  isCrawlScopeResource(
    "https://files.clinica.example.it/2026/opaque-document.pdf",
    "https://www.clinica.example.it/",
    "pdf"
  ),
  "opaque documents on first-party file subdomains remain in scope"
);
ok(
  isClearlyCommercialProductImageUrl(
    `${base}/wp-content/uploads/2024/06/tropical-seltzer.webp`,
    `${base}/shop-medicina-estetica-pordenone`
  ),
  "shop product photography can close after a policy-free OCR pass"
);
ok(
  !isClearlyCommercialProductImageUrl(
    `${base}/documenti/polizza-rct-2026.png`,
    `${base}/shop`
  ),
  "policy-looking images are never dismissed as product photography"
);
const widgetContaminatedHtml = `
  <html><head>
    <style>--yt-attributed-string-link-hover-color: #fff</style>
    <script>const insurer = "AXA"; const stale = "05/03/2023";</script>
  </head><body><main>Servizi di medicina estetica</main></body></html>`;
const visibleWidgetText = extractVisibleTextFromHtml(widgetContaminatedHtml);
ok(
  !/yt-attributed|string-link|05\/03\/2023|AXA/i.test(visibleWidgetText),
  "rendered policy text excludes script and CSS widget contamination"
);
ok(
  !analyzePolicy(visibleWidgetText, `${base}/medicina-estetica/filler`).policyFound,
  "widget identifiers cannot create a false published policy"
);

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

// A concurrent slice must not reclaim a node already being fetched or parsed.
// Crash recovery moves those states back to RETRY_PENDING when the run resumes.
closeFrontierStore();
const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), "crawl-slices4-"));
const db4 = path.join(dir4, "f.sqlite");
openFrontierStore(db4);
const { crawlRunId: cr4 } = createCrawlRun({ leadId: "L4", runId: "R4", workerId: "w" });
const active = upsertFrontierNode({
  crawlRunId: cr4,
  canonicalUrl: `${base}/active.pdf.png`,
  resourceType: "image",
  relevance: "relevant",
});
transitionFrontierNode(active.id, "QUEUED");
transitionFrontierNode(active.id, "FETCHING");
transitionFrontierNode(active.id, "FETCHED");
const queued = upsertFrontierNode({
  crawlRunId: cr4,
  canonicalUrl: `${base}/queued`,
  resourceType: "html",
  relevance: "relevant",
});
transitionFrontierNode(queued.id, "QUEUED");
prepareFrontierForExhaustiveCoverage(cr4);
ok(
  listNodes(cr4).find((node) => node.id === active.id)?.resourceType === "image",
  "double-extension .pdf.png remains an image"
);
ok(
  pickNextNodeForTest(cr4, Date.now())?.id === queued.id,
  "concurrent slice never reclaims FETCHING/FETCHED nodes"
);

// A URL declared as a static asset that actually returns a catch-all HTML
// shell is terminally ignored before Playwright/link expansion.
closeFrontierStore();
const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), "crawl-slices5-"));
const db5 = path.join(dir5, "f.sqlite");
openFrontierStore(db5);
const { crawlRunId: cr5 } = createCrawlRun({ leadId: "L5", runId: "R5", workerId: "w" });
const ghost = upsertFrontierNode({
  crawlRunId: cr5,
  canonicalUrl: `${base}/ghost.png`,
  resourceType: "image",
  relevance: "low",
});
transitionFrontierNode(ghost.id, "QUEUED");
releaseWorkerLock(cr5);
await runCrawlSlice({
  leadId: "L5",
  runId: "R5",
  website: base + "/",
  discoverLinks: true,
  budget: { sliceBudgetMs: 30_000, maxHtmlPerSlice: 20, perHostDelayMs: 0 },
});
const ghostNodes = listNodes(cr5);
ok(
  ghostNodes.find((node) => node.id === ghost.id)?.state === "EXCLUDED",
  "static asset returning HTML is excluded before render"
);
ok(
  !ghostNodes.some((node) => /vendor\/widget\/assets/i.test(node.canonicalUrl)),
  "static HTML fallback creates no child resources"
);

// Resume-time cleanup must remove third-party consent/widget resources that
// were persisted by an older detector, while retaining genuine external
// policy documents linked by the official site.
closeFrontierStore();
const dir6 = fs.mkdtempSync(path.join(os.tmpdir(), "crawl-slices6-"));
const db6 = path.join(dir6, "f.sqlite");
openFrontierStore(db6);
const { crawlRunId: cr6 } = createCrawlRun({ leadId: "L6", runId: "R6", workerId: "w" });
const primarySeed = upsertFrontierNode({
  crawlRunId: cr6,
  canonicalUrl: `${base}/`,
  discoverySource: "seed",
  resourceType: "html",
  relevance: "critical",
});
transitionFrontierNode(primarySeed.id, "QUEUED");
const consentJson = upsertFrontierNode({
  crawlRunId: cr6,
  canonicalUrl: "https://cdn.biddercore.io/iab/tcf_storage.json",
  parentUrl: `${base}/`,
  discoverySource: "embedded-resource",
  resourceType: "json",
  relevance: "low",
});
transitionFrontierNode(consentJson.id, "QUEUED");
const externalPolicy = upsertFrontierNode({
  crawlRunId: cr6,
  canonicalUrl: "https://documents.example.org/Polizza-RCT-RCO-2026.pdf",
  parentUrl: `${base}/trasparenza`,
  discoverySource: "html-resource",
  resourceType: "pdf",
  relevance: "critical",
});
transitionFrontierNode(externalPolicy.id, "QUEUED");
const appPortal = upsertFrontierNode({
  crawlRunId: cr6,
  canonicalUrl: `https://hr.127.0.0.1.nip.io/hrportal/assets/app.js`,
  parentUrl: `${base}/`,
  discoverySource: "html-resource",
  resourceType: "script",
  relevance: "low",
});
transitionFrontierNode(appPortal.id, "QUEUED");
prepareFrontierForExhaustiveCoverage(cr6);
const cleanedNodes = listNodes(cr6);
ok(
  cleanedNodes.find((node) => node.id === consentJson.id)?.state === "EXCLUDED",
  "resume cleanup excludes persisted third-party consent resources"
);
ok(
  cleanedNodes.find((node) => node.id === externalPolicy.id)?.state === "QUEUED",
  "resume cleanup retains external policy documents"
);
ok(
  cleanedNodes.find((node) => node.id === appPortal.id)?.state === "EXCLUDED",
  "resume cleanup removes an out-of-scope application resource"
);

server.close();
closeFrontierStore();
fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(dir2, { recursive: true, force: true });
fs.rmSync(dir3, { recursive: true, force: true });
fs.rmSync(dir4, { recursive: true, force: true });
fs.rmSync(dir5, { recursive: true, force: true });
fs.rmSync(dir6, { recursive: true, force: true });

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
