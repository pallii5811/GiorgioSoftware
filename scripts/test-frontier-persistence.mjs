/**
 * Frontier persistence + resume tests (deterministic, no network).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  openFrontierStore,
  closeFrontierStore,
  createCrawlRun,
  upsertFrontierNode,
  transitionFrontierNode,
  setCrawlRunFlags,
  completeCrawlRun,
  deriveCrawlCompleteness,
  listNodes,
  getCrawlRun,
  releaseWorkerLock,
  heartbeatCrawlRun,
} from "../src/lib/sanita/frontier-store.ts";
import { canEmitHot } from "../src/lib/sanita/can-emit-hot.ts";

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-"));
const dbPath = path.join(dir, "frontier.sqlite");

openFrontierStore(dbPath);
const { crawlRunId, resumed: r0 } = createCrawlRun({
  leadId: "lead1",
  runId: "final-closure-e2e-20260719",
  workerId: "w1",
});
ok(!r0, "fresh run created");

const urls = [
  "https://clinic.example/it/",
  "https://clinic.example/it/trasparenza",
  "https://clinic.example/it/about",
  "https://clinic.example/it/docs/info.pdf",
];
const nodeIds = [];
for (const u of urls) {
  const { id, created } = upsertFrontierNode({
    crawlRunId,
    canonicalUrl: u,
    resourceType: u.endsWith(".pdf") ? "pdf" : "html",
    relevance: /trasparenza|pdf/i.test(u) ? "critical" : "relevant",
  });
  ok(created, `node created ${u}`);
  nodeIds.push(id);
}

// Interrupt mid-run: only first two completed
for (const id of nodeIds.slice(0, 2)) {
  transitionFrontierNode(id, "QUEUED");
  transitionFrontierNode(id, "FETCHING");
  transitionFrontierNode(id, "FETCHED");
  transitionFrontierNode(id, "PARSED");
  transitionFrontierNode(id, "COMPLETED", { httpStatus: 200 });
}
heartbeatCrawlRun(crawlRunId, "mid-interrupt");
releaseWorkerLock(crawlRunId);
const mid = listNodes(crawlRunId);
ok(mid.filter((n) => n.state === "COMPLETED").length === 2, "2 completed before interrupt");
ok(mid.filter((n) => n.state === "DISCOVERED").length === 2, "2 still discovered");
const countsBefore = getCrawlRun(crawlRunId);
closeFrontierStore();

// Restart — resume same run, no duplicates
openFrontierStore(dbPath);
const { crawlRunId: id2, resumed } = createCrawlRun({
  leadId: "lead1",
  runId: "final-closure-e2e-20260719",
  workerId: "w2",
});
ok(resumed, "resume after interrupt");
ok(id2 === crawlRunId, "same crawlRunId");
const beforeCount = listNodes(id2).length;
for (const u of urls) {
  const { created } = upsertFrontierNode({
    crawlRunId: id2,
    canonicalUrl: u,
    resourceType: u.endsWith(".pdf") ? "pdf" : "html",
    relevance: "relevant",
  });
  ok(!created, `no duplicate on resume ${u}`);
}
ok(listNodes(id2).length === beforeCount, "node count unchanged after resume upsert");

for (const n of listNodes(id2)) {
  if (n.state === "COMPLETED") continue;
  transitionFrontierNode(n.id, "QUEUED");
  transitionFrontierNode(n.id, "FETCHING");
  transitionFrontierNode(n.id, "FETCHED");
  transitionFrontierNode(n.id, "PARSED");
  transitionFrontierNode(n.id, "COMPLETED", { httpStatus: 200 });
}
setCrawlRunFlags(id2, {
  identityVerified: true,
  scopeVerified: true,
  sitemapStatus: "DISCOVERED_COMPLETE",
  ocrDoubts: 0,
  unresolvedPolicyCandidates: 0,
  urlCapReached: false,
  timeCapReached: false,
});
const completeness = deriveCrawlCompleteness(id2);
ok(completeness.complete === true, "completeness derived complete from DB");
ok(completeness.unresolvedRelevantUrls === 0, "zero pending");
ok(completeness.failedRelevantUrls === 0, "zero failed");
completeCrawlRun(id2, "ok");
const run = getCrawlRun(id2);
ok(run?.state === "COMPLETED", "run state COMPLETED");
ok(Number(run?.totalDiscovered) === countsBefore?.totalDiscovered || Number(run?.totalDiscovered) === 4, "discovered count stable");

ok(
  canEmitHot({
    website: "https://clinic.example",
    websiteReachable: true,
    pagesVisited: 20,
    policyExhaustive: true,
    needsOcrReview: false,
    crawlCompleteness: completeness,
    identityStatus: "OFFICIAL_CONFIRMED",
    category: "Casa di cura",
    crawlRunId: id2,
    requirePersistedCompleteness: true,
  }),
  "canEmitHot only after persisted completeness"
);

// Incomplete cannot emit HOT
const { crawlRunId: badId } = createCrawlRun({
  leadId: "lead2",
  runId: "final-closure-e2e-20260719-bad",
  workerId: "w2",
});
upsertFrontierNode({
  crawlRunId: badId,
  canonicalUrl: "https://x.it/a",
  resourceType: "html",
  relevance: "relevant",
});
setCrawlRunFlags(badId, {
  identityVerified: true,
  scopeVerified: true,
  sitemapStatus: "DISCOVERED_PARTIAL",
});
const badC = deriveCrawlCompleteness(badId);
ok(badC.complete === false, "partial sitemap incomplete");
ok(
  !canEmitHot({
    website: "https://x.it",
    websiteReachable: true,
    pagesVisited: 20,
    policyExhaustive: true,
    needsOcrReview: false,
    crawlCompleteness: { ...badC, complete: true }, // forged complete ignored when requirePersisted
    identityStatus: "OFFICIAL_CONFIRMED",
    category: "RSA",
    crawlRunId: badId,
    requirePersistedCompleteness: true,
  }),
  "forged complete:true ignored — DB derivation wins"
);

closeFrontierStore();
fs.rmSync(dir, { recursive: true, force: true });

console.log(
  JSON.stringify(
    {
      suite: "frontier-persistence",
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
