/**
 * Stop-ship gates — MUST fail on HEAD b9d0556 (false PRC).
 * Product path: analyzeLead → crawlLeadViaSlices (not crawlSite).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";

const ROOT = path.resolve(".");

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

console.log("\n=== STOP-SHIP product path ===\n");

const scanSrc = fs.readFileSync(path.join(ROOT, "src/lib/sanita/scan-engine.ts"), "utf8");
ok(
  /crawlLeadViaSlices/.test(scanSrc) && !/await crawlSite\(/.test(scanSrc),
  "1 analyzeLead_uses_persisted_slice_runtime / 3 no_monolithic_crawlSite_in_production_path"
);
ok(/from "@\/lib\/sanita\/lead-crawl-runtime"/.test(scanSrc), "scan-engine imports lead-crawl-runtime");

const runtimeSrc = fs.readFileSync(path.join(ROOT, "src/lib/sanita/lead-crawl-runtime.ts"), "utf8");
ok(
  /createCrawlRun/.test(runtimeSrc) && /runCrawlUntilSettled/.test(runtimeSrc),
  "2 frontier_exists_before_first_fetch (createCrawlRun before settle)"
);

ok(
  /packRetryPendingEvidence/.test(scanSrc) &&
    !/packEvidence\("REVIEW", evidenceBody, audit\)/.test(scanSrc),
  "4 retry_pending_is_not_review"
);
ok(/retryPending/.test(scanSrc) && /reviewHuman/.test(scanSrc), "counters retryPending + reviewHuman");

const sliceSrc = fs.readFileSync(path.join(ROOT, "src/lib/sanita/crawl-slice-runner.ts"), "utf8");
ok(
  !/hot_finalize_non_critical/.test(sliceSrc) && !/exclusionReason:\s*"html_cap"/.test(sliceSrc),
  "6 no_hot_finalize_exclusion_shortcuts"
);
ok(
  !/setCrawlRunFlags\(crawlRunId,\s*\{\s*identityVerified:\s*true/.test(sliceSrc) &&
    !/sitemapStatus:\s*"DISCOVERED_COMPLETE"/.test(sliceSrc),
  "5 no_manual_identity_or_scope_completion"
);

ok(
  /nextRetryAt/.test(sliceSrc) && /pickNextNodeForTest/.test(sliceSrc),
  "7 nextRetryAt_is_respected (export + due check)"
);

const negSrc = fs.readFileSync(path.join(ROOT, "src/lib/sanita/negative-document.ts"), "utf8");
const pubSrc = fs.readFileSync(path.join(ROOT, "src/lib/sanita/published-fast-path.ts"), "utf8");
ok(/classifyNegativeInsuranceDocument/.test(negSrc) && /CCNL/.test(negSrc), "8 ccnl_is_not_policy");
ok(
  /classifyNegativeInsuranceDocument/.test(pubSrc) &&
    !/identityStatus:\s*input\.identityStatus\s*\?\?\s*"OFFICIAL_CONFIRMED"/.test(pubSrc) &&
    !/entityAttributed:\s*true/.test(pubSrc),
  "9 historical_metadata_cannot_certify_unrelated_document"
);

const recSrc = fs.readFileSync(path.join(ROOT, "scripts/staging-runtime-recovery.mjs"), "utf8");
ok(
  !/awardDate:\s*new Date\(\)/.test(recSrc) &&
    !/relevance:\s*"HIGH"/.test(recSrc) &&
    !/officialSource:\s*true/.test(recSrc) &&
    !/insuranceNeed === "NOT_FOUND" \? "STRONGLY_INFERRED"/.test(recSrc) &&
    !/,\s*50,\s*now,\s*now,\s*now/.test(recSrc.replace(/\s+/g, " ")),
  "10 gare_fields_must_have_provenance"
);

const browserSrc = fs.readFileSync(path.join(ROOT, "scripts/test-staging-browser.mjs"), "utf8");
ok(
  /semantic/i.test(browserSrc) && /processingState|businessVerdict|policyCompany/i.test(browserSrc),
  "11 browser_semantic_acceptance"
);

const {
  openFrontierStore,
  closeFrontierStore,
  createCrawlRun,
  upsertFrontierNode,
  transitionFrontierNode,
  getCrawlRun,
} = await import("../src/lib/sanita/frontier-store.ts");
const { pickNextNodeForTest } = await import("../src/lib/sanita/crawl-slice-runner.ts");
const { classifyNegativeInsuranceDocument } = await import("../src/lib/sanita/negative-document.ts");
const { crawlLeadViaSlices } = await import("../src/lib/sanita/lead-crawl-runtime.ts");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stop-ship-"));
openFrontierStore(path.join(dir, "f.sqlite"));
const { crawlRunId } = createCrawlRun({ leadId: "L-retry", runId: "r1", workerId: "t" });
const { id } = upsertFrontierNode({
  crawlRunId,
  canonicalUrl: "http://example.test/page",
  resourceType: "html",
  relevance: "relevant",
});
transitionFrontierNode(id, "QUEUED");
transitionFrontierNode(id, "FETCHING");
const future = new Date(Date.now() + 60_000).toISOString();
transitionFrontierNode(id, "RETRY_PENDING", {
  bumpRetry: true,
  nextRetryAt: future,
  lastError: "timeout",
});
ok(pickNextNodeForTest(crawlRunId, Date.now()) === null, "7a nextRetryAt not ready");
ok(pickNextNodeForTest(crawlRunId, Date.now() + 120_000)?.id === id, "7b nextRetryAt ready after due");
closeFrontierStore();

const ccnl = classifyNegativeInsuranceDocument(
  "Contratto collettivo nazionale di lavoro CCNL ARIS RSA personale",
  "https://example.test/CCNLarisrsa.pdf"
);
ok(ccnl.blocked && ccnl.kind === "CCNL", "8b ccnl runtime blocked");

const pages = {
  "/": "<html><body>Home test</body></html>",
  "/robots.txt": "User-agent: *\nDisallow:",
};
const server = http.createServer((req, res) => {
  const u = req.url?.split("?")[0] || "/";
  if (u === "/sitemap.xml") {
    res.writeHead(404);
    res.end("nf");
    return;
  }
  res.writeHead(pages[u] ? 200 : 404, { "content-type": "text/html" });
  res.end(pages[u] || "nf");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
process.env.FRONTIER_DB_PATH = path.join(dir, "prod.sqlite");
process.env.CRAWL_SLICE_BUDGET_MS = "3000";
process.env.CRAWL_MAX_HTML_PER_SLICE = "3";
process.env.PER_HOST_DELAY_MS = "0";
process.env.HTTP_REQUEST_TIMEOUT_MS = "3000";
process.env.CRAWL_RUN_MAX_WALL_CLOCK_MS = "20000";

openFrontierStore(process.env.FRONTIER_DB_PATH);
const result = await crawlLeadViaSlices({
  leadId: "L-prod",
  website: base + "/",
  maxSlices: 2,
  discoverLinks: false,
});
ok(Boolean(result.crawlRunId && getCrawlRun(result.crawlRunId)), "2b CrawlRun before/during product crawl");
ok(result.frontierCreatedBeforeFetch === true, "2c frontierCreatedBeforeFetch");
ok(result.slices.length >= 1, "1b slice runner invoked");
server.close();
closeFrontierStore();

console.log(`\nStop-ship: ${pass} pass, ${fail} fail\n`);
process.exit(fail > 0 ? 1 : 0);
