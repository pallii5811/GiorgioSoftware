/**
 * hot-negative-proof + atomic-verdict-persistence
 */
import { deriveCrawlComplete } from "../src/lib/evidence/contract.ts";
import { canEmitHot, explainCanEmitHot } from "../src/lib/sanita/can-emit-hot.ts";
import { finalizeVerdict } from "../src/lib/sanita/finalize-verdict.ts";
import {
  assertAtomicHotPersist,
  HotIncompleteStopError,
  getLastStopCondition,
  isWorkerStoppedForHot,
  resetHotWorkerStopForTests,
  HOT_INCOMPLETE_STOP,
} from "../src/lib/sanita/atomic-verdict.ts";

const start = Date.now();
let pass = 0;
let fail = 0;

function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}

const baseComplete = deriveCrawlComplete({
  identityVerified: true,
  sitemapStatus: "DISCOVERED_COMPLETE",
  htmlQueueExhausted: true,
  relevantLinksProcessed: true,
  relevantDocumentsProcessed: true,
  jsonEndpointsProcessed: true,
  sameHostScriptsProcessed: true,
  unresolvedRelevantUrls: 0,
  failedRelevantUrls: 0,
  unreadableRelevantDocuments: 0,
  criticalOcrDoubts: 0,
  urlCapReached: false,
  timeCapReached: false,
});

const good = {
  website: "https://example.it",
  websiteReachable: true,
  pagesVisited: 20,
  policyExhaustive: true,
  needsOcrReview: false,
  crawlCompleteness: baseComplete,
  identityStatus: "OFFICIAL_CONFIRMED",
  category: "Casa di cura",
};
ok(canEmitHot(good), "complete evidence → canEmitHot");

const cases = [
  ["sitemap partial", { ...good, crawlCompleteness: deriveCrawlComplete({ ...baseComplete, sitemapStatus: "DISCOVERED_PARTIAL", identityVerified: true }) }],
  ["timeout / time cap", { ...good, crawlCompleteness: deriveCrawlComplete({ ...baseComplete, timeCapReached: true, identityVerified: true }) }],
  ["PDF illeggibile", { ...good, crawlCompleteness: deriveCrawlComplete({ ...baseComplete, unreadableRelevantDocuments: 1, identityVerified: true }) }],
  ["OCR dubbio", { ...good, needsOcrReview: true }],
  ["URL fallito", { ...good, crawlCompleteness: deriveCrawlComplete({ ...baseComplete, failedRelevantUrls: 1, identityVerified: true }) }],
  ["identity insufficient", { ...good, identityStatus: "INSUFFICIENT" }],
  ["cap URL", { ...good, crawlCompleteness: deriveCrawlComplete({ ...baseComplete, urlCapReached: true, identityVerified: true }) }],
  ["JS/script non elaborati", { ...good, crawlCompleteness: deriveCrawlComplete({ ...baseComplete, sameHostScriptsProcessed: false, identityVerified: true }) }],
];

for (const [name, ev] of cases) {
  ok(!canEmitHot(ev), `blocca HOT: ${name}`);
  const fin = finalizeVerdict({
    verdict: "HOT",
    evidenceBody: "x",
    pagesVisited: ev.pagesVisited,
    websiteReachable: ev.websiteReachable,
    website: ev.website,
    policyExhaustive: ev.policyExhaustive,
    needsOcrReview: ev.needsOcrReview,
    crawlCompleteness: ev.crawlCompleteness,
    identityStatus: ev.identityStatus,
    category: ev.category,
  });
  ok(fin.verdict === "REVIEW", `finalizeVerdict → REVIEW: ${name}`);
  if (name === "OCR dubbio" || name === "timeout / time cap" || name === "URL fallito") {
    ok(fin.processingHint === "RETRY_PENDING", `tech hint RETRY_PENDING: ${name}`);
  }
  if (name === "identity insufficient") {
    ok(fin.processingHint === "REVIEW_HUMAN", "identity → REVIEW_HUMAN hint");
  }
}

import { buildFrontierFromCrawl, frontierBlocksHot } from "../src/lib/sanita/crawl-frontier-ledger.ts";
const openFrontier = buildFrontierFromCrawl({
  baseUrl: "https://example.it",
  pagesVisited: ["https://example.it/"],
  policyPdfsQueued: 2,
  policyPdfsRead: 0,
  needsOcrReview: false,
  completeness: deriveCrawlComplete({
    ...baseComplete,
    unresolvedRelevantUrls: 1,
    identityVerified: true,
  }),
});
ok(frontierBlocksHot(openFrontier) != null, "frontier open blocks HOT");
ok(!canEmitHot({ ...good, frontier: openFrontier }), "canEmitHot respects frontier");
const closedFrontier = buildFrontierFromCrawl({
  baseUrl: "https://example.it",
  pagesVisited: Array.from({ length: 15 }, (_, i) => `https://example.it/p${i}`),
  policyPdfsQueued: 0,
  policyPdfsRead: 0,
  needsOcrReview: false,
  completeness: baseComplete,
});
ok(frontierBlocksHot(closedFrontier) == null, "exhausted frontier allows HOT");
ok(canEmitHot({ ...good, frontier: closedFrontier }), "canEmitHot with exhausted frontier");

resetHotWorkerStopForTests();
let threw = false;
try {
  assertAtomicHotPersist("HOT", {
    ...good,
    crawlCompleteness: deriveCrawlComplete({
      ...baseComplete,
      timeCapReached: true,
      identityVerified: true,
    }),
  });
} catch (e) {
  threw = e instanceof HotIncompleteStopError;
}
ok(threw, "assertAtomicHotPersist throws HotIncompleteStopError");
ok(getLastStopCondition() === HOT_INCOMPLETE_STOP, "stop condition recorded");
ok(isWorkerStoppedForHot() === true, "worker stop flag set");

resetHotWorkerStopForTests();
assertAtomicHotPersist("HOT", good);
ok(!isWorkerStoppedForHot(), "HOT completo non ferma worker");
assertAtomicHotPersist("REVIEW", { ...good, crawlCompleteness: null });
ok(true, "REVIEW bypass atomic HOT gate");

const elapsed = Date.now() - start;
console.log(
  JSON.stringify(
    {
      suite: "hot-negative-proof",
      exitCode: fail === 0 ? 0 : 1,
      durationMs: elapsed,
      pass,
      fail,
      skipped: 0,
      blockedAttempts: cases.length + 1,
    },
    null,
    2
  )
);
process.exit(fail === 0 ? 0 : 1);
