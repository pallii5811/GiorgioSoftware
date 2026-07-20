/**
 * Atomic verdict gateway — no invalid terminal writes.
 */
import { prepareSanitaVerdictPersist, PublishedGateError } from "../src/lib/sanita/verdict-gateway.ts";
import { HotIncompleteStopError, resetHotWorkerStopForTests } from "../src/lib/sanita/atomic-verdict.ts";
import { deriveCrawlComplete } from "../src/lib/evidence/contract.ts";

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

resetHotWorkerStopForTests();
const complete = deriveCrawlComplete({
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

let threw = false;
try {
  prepareSanitaVerdictPersist({
    legacyVerdict: "HOT",
    evidenceBody: "x",
    hotEvidence: {
      website: "https://x.it",
      websiteReachable: true,
      pagesVisited: 20,
      policyExhaustive: true,
      needsOcrReview: false,
      crawlCompleteness: deriveCrawlComplete({
        identityVerified: true,
        sitemapStatus: "DISCOVERED_COMPLETE",
        htmlQueueExhausted: true,
        relevantLinksProcessed: true,
        relevantDocumentsProcessed: true,
        jsonEndpointsProcessed: true,
        sameHostScriptsProcessed: true,
        unresolvedRelevantUrls: 0,
        failedRelevantUrls: 2,
        unreadableRelevantDocuments: 0,
        criticalOcrDoubts: 0,
        urlCapReached: false,
        timeCapReached: false,
      }),
      identityStatus: "OFFICIAL_CONFIRMED",
      category: "RSA",
    },
  });
} catch (e) {
  threw =
    e instanceof HotIncompleteStopError ||
    (e && typeof e === "object" && "stopCondition" in e);
}
ok(threw, "incomplete HOT rejected before persist");

const hotOk = prepareSanitaVerdictPersist({
  legacyVerdict: "HOT",
  evidenceBody: "assenza",
  hotEvidence: {
    website: "https://x.it",
    websiteReachable: true,
    pagesVisited: 20,
    policyExhaustive: true,
    needsOcrReview: false,
    crawlCompleteness: complete,
    identityStatus: "OFFICIAL_CONFIRMED",
    category: "Casa di cura",
  },
});
ok(hotOk.allowed && hotOk.businessVerdict === "HOT_VERIFIED", "HOT verified prepared");

let pubThrow = false;
try {
  prepareSanitaVerdictPersist({
    legacyVerdict: "PUBLISHED",
    evidenceBody: "blog",
    validationStatus: "CURRENT_VERIFIED",
    publishedEvidence: {
      identityStatus: "OFFICIAL_CONFIRMED",
      sourceClass: "BLOG",
      exactUrl: "https://blog.example/gelli",
      contentFetched: true,
      contentExcerpt: "legge gelli",
      entityAttributed: true,
      hasStrongInsuranceSignal: true,
      hasMediumInsuranceSignals: 3,
      category: "Casa di cura",
    },
  });
} catch (e) {
  pubThrow = e instanceof PublishedGateError;
}
ok(pubThrow, "blog source cannot persist PUBLISHED");

const legacyKeep = prepareSanitaVerdictPersist({
  legacyVerdict: "PUBLISHED",
  evidenceBody: "storico",
  validationStatus: "REVALIDATION_PENDING",
  businessVerdict: "PUBLISHED_EXPIRED",
  processingState: "RETRY_PENDING",
});
ok(legacyKeep.allowed, "legacy PUB revalidation allowed without publishedEvidence");
ok(/STATE:RETRY_PENDING/.test(legacyKeep.evidenceBody), "stamped RETRY");

console.log(
  JSON.stringify(
    { suite: "atomic-verdict", exitCode: fail === 0 ? 0 : 1, durationMs: Date.now() - start, pass, fail },
    null,
    2
  )
);
process.exit(fail === 0 ? 0 : 1);
