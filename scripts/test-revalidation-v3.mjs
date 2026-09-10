/**
 * Tests for revalidation v3: checkpoint migration, RETRY not terminal, isolation contracts.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  migrateCheckpointV2toV3,
  classifyResult,
  isTerminalState,
  writeResultAtomic,
  resultHasRequiredFields,
  emptyCheckpointV3,
  saveCheckpointAtomic,
  TERMINAL_STATES,
  buildWorkerNodeOptions,
  reconcileTerminalCertifications,
  selectDualOutcome,
  alignCertifiedTerminalResult,
  sortDueRetryEntries,
  interleaveFrontierAndGeneralEntries,
  selectNextRetryEntry,
  nextRetryAt,
} from "./revalidate-checkpoint-v3.mjs";

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reval-v3-"));
const resultsDir = path.join(tmp, "results");
fs.mkdirSync(resultsDir);

// existing 5 retry migration
const five = [
  "cmqkld5s0009u108eghihpoxi",
  "id2",
  "id3",
  "id4",
  "id5",
];
const v2 = {
  version: 2,
  testedCodeSha: "a".repeat(40),
  done: {},
  stats: { processed: 5, retry: 5 },
};
for (const id of five) {
  v2.done[id] = { finishedAt: "2026-07-20T17:00:00Z", newVerdict: null, processingState: "RETRY_PENDING", reasonCode: "RETRY_PENDING" };
  fs.writeFileSync(
    path.join(resultsDir, `${id}.json`),
    JSON.stringify({
      id,
      processingState: "RETRY_PENDING",
      newVerdict: null,
      reasonCode: "RETRY_PENDING",
      dualDisagreement: false,
      finishedAt: "2026-07-20T17:00:00Z",
    })
  );
}
const mig = migrateCheckpointV2toV3(v2, resultsDir, "b".repeat(40));
ok(mig.migrated === 5, "existing_5_retry_results_are_migrated");
ok(mig.retry === 5, "retry_pending_is_resumed (in retryQueue)");
ok(mig.terminal === 0, "retry_pending_not_added_to_terminal");
ok(Object.keys(mig.checkpoint.retryQueue).length === 5, "retryQueue size 5");
ok(Object.keys(mig.checkpoint.terminal).length === 0, "terminal empty after retry migrate");

// terminal not reprocessed
const v2b = {
  version: 2,
  done: {
    hot1: { processingState: "HOT_VERIFIED", newVerdict: "HOT" },
  },
};
fs.writeFileSync(
  path.join(resultsDir, "hot1.json"),
  JSON.stringify({
    id: "hot1",
    processingState: "HOT_VERIFIED",
    newVerdict: "HOT",
    crawlComplete: true,
    negativeIdentityCertified: true,
    siteCoverageCertified: true,
    pass1: {
      processingState: "HOT_VERIFIED",
      crawlComplete: true,
      policyFound: false,
      negativeIdentityCertified: true,
      siteCoverageCertified: true,
    },
    pass2: {
      processingState: "HOT_VERIFIED",
      crawlComplete: true,
      policyFound: false,
      negativeIdentityCertified: true,
      siteCoverageCertified: true,
    },
  })
);
const mig2 = migrateCheckpointV2toV3(v2b, resultsDir, "c".repeat(40));
ok(mig2.terminal === 1 && mig2.retry === 0, "terminal_result_is_not_reprocessed");
ok(isTerminalState("HOT_VERIFIED"), "HOT_VERIFIED terminal");
ok(!isTerminalState("RETRY_PENDING"), "RETRY_PENDING not terminal");

const orderedContinuations = sortDueRetryEntries([
  {
    id: "old-generic",
    meta: {
      lastReason: "RETRY_PENDING",
      nextRetryAt: "2026-07-20T00:00:00Z",
      lastAttemptAt: "2026-07-20T00:00:00Z",
    },
  },
  {
    id: "older-frontier",
    meta: {
      lastReason: "FRONTIER_INCOMPLETE",
      nextRetryAt: "2026-07-21T00:00:00Z",
      lastAttemptAt: "2026-07-21T00:00:00Z",
      frontierSnapshot: { pending: 80 },
    },
  },
  {
    id: "active-frontier",
    meta: {
      lastReason: "LEAD_WALL_TIMEOUT",
      nextRetryAt: "2026-07-22T00:00:00Z",
      lastAttemptAt: "2026-07-22T00:00:00Z",
      frontierSnapshot: { pending: 20 },
    },
  },
]);
ok(
  orderedContinuations.map((entry) => entry.id).join(",") ===
    "active-frontier,older-frontier,old-generic",
  "closest healthy frontiers finish first without leaving the active lane"
);
ok(
  interleaveFrontierAndGeneralEntries(orderedContinuations)
    .map((entry) => entry.id)
    .join(",") === "active-frontier,old-generic,older-frontier",
  "two-worker queue reserves one lane for general archive progress"
);
const explicitGenericContinuation = sortDueRetryEntries([
  {
    id: "ordinary-retry",
    meta: {
      lastReason: "RETRY_PENDING",
      nextRetryAt: "2026-07-20T00:00:00Z",
    },
  },
  {
    id: "persisted-frontier",
    meta: {
      lastReason: "RETRY_PENDING",
      continuationReady: true,
      nextRetryAt: "2026-07-22T00:00:00Z",
      frontierSnapshot: { pending: 12 },
    },
  },
]);
ok(
  explicitGenericContinuation[0].id === "persisted-frontier",
  "persisted pending frontier stays in the continuation lane regardless of generic reason"
);
const secondPassContinuation = sortDueRetryEntries([
  {
    id: "small-p1",
    meta: {
      lastReason: "FRONTIER_INCOMPLETE",
      continuationReady: true,
      passLabel: "p1",
      frontierSnapshot: { pending: 1 },
    },
  },
  {
    id: "advanced-p2",
    meta: {
      lastReason: "FRONTIER_INCOMPLETE",
      continuationReady: true,
      passLabel: "p2",
      frontierSnapshot: { pending: 200 },
    },
  },
]);
ok(
  secondPassContinuation[0].id === "advanced-p2",
  "second certified-absence pass completes before starting another dual scan"
);
const twoSecondPassLanes = interleaveFrontierAndGeneralEntries([
  {
    id: "p2-a",
    meta: {
      lastReason: "FRONTIER_INCOMPLETE",
      continuationReady: true,
      passLabel: "p2",
      frontierSnapshot: { pending: 10 },
    },
  },
  {
    id: "p2-b",
    meta: {
      lastReason: "FRONTIER_INCOMPLETE",
      continuationReady: true,
      passLabel: "p2",
      frontierSnapshot: { pending: 20 },
    },
  },
  {
    id: "general",
    meta: { lastReason: "RETRY_PENDING" },
  },
]);
ok(
  twoSecondPassLanes
    .slice(0, 2)
    .map((entry) => entry.id)
    .join(",") === "p2-a,p2-b",
  "two workers finish two existing second passes before opening more p1 work"
);
const orderedGeneral = sortDueRetryEntries([
  {
    id: "large-general",
    meta: {
      lastReason: "RETRY_PENDING",
      attempts: 0,
      nextRetryAt: "2026-07-20T00:00:00Z",
      frontierSnapshot: { pending: 500 },
    },
  },
  {
    id: "small-general",
    meta: {
      lastReason: "RETRY_PENDING",
      attempts: 9,
      nextRetryAt: "2026-07-22T00:00:00Z",
      frontierSnapshot: { pending: 5 },
    },
  },
]);
ok(
  orderedGeneral[0].id === "large-general",
  "untouched general work outranks repeatedly blocked pending-zero/small frontiers"
);
const inferredContinuationNeedsPending = sortDueRetryEntries([
  {
    id: "stale-incomplete",
    meta: {
      lastReason: "FRONTIER_INCOMPLETE",
      attempts: 12,
      frontierSnapshot: { pending: 0, blocked: 2 },
    },
  },
  {
    id: "untouched",
    meta: {
      lastReason: "RECERTIFICATION_REQUIRED",
      attempts: 0,
    },
  },
]);
ok(
  inferredContinuationNeedsPending[0].id === "untouched",
  "blocked frontier without pending work cannot occupy the continuation lane"
);
const identityCannotOwnContinuationLane = interleaveFrontierAndGeneralEntries([
  {
    id: "wrong-site",
    meta: {
      lastReason: "IDENTITY_MISMATCH",
      continuationReady: true,
      attempts: 20,
      frontierSnapshot: { pending: 200 },
    },
  },
  {
    id: "real-continuation",
    meta: {
      lastReason: "FRONTIER_INCOMPLETE",
      continuationReady: true,
      attempts: 1,
      frontierSnapshot: { pending: 50 },
    },
  },
  {
    id: "untouched-general",
    meta: {
      lastReason: "RECERTIFICATION_REQUIRED",
      attempts: 0,
    },
  },
]);
ok(
  identityCannotOwnContinuationLane
    .slice(0, 2)
    .map((entry) => entry.id)
    .join(",") === "real-continuation,untouched-general",
  "identity mismatch cannot consume the resumable-frontier worker"
);
const activeContinuation = {
  id: "active-frontier",
  meta: {
    lastReason: "FRONTIER_INCOMPLETE",
    continuationReady: true,
    frontierSnapshot: { pending: 90 },
  },
};
const nextWithContinuationRunning = selectNextRetryEntry(
  [
    {
      id: "next-frontier",
      meta: {
        lastReason: "FRONTIER_INCOMPLETE",
        continuationReady: true,
        frontierSnapshot: { pending: 10 },
      },
    },
    {
      id: "general-zero-attempt",
      meta: { lastReason: "RECERTIFICATION_REQUIRED", attempts: 0 },
    },
  ],
  [activeContinuation]
);
ok(
  nextWithContinuationRunning?.id === "general-zero-attempt",
  "an active continuation forces the free worker to select general work"
);
const positiveWithContinuationRunning = selectNextRetryEntry(
  [
    {
      id: "next-frontier",
      meta: {
        lastReason: "FRONTIER_INCOMPLETE",
        continuationReady: true,
        frontierSnapshot: { pending: 10 },
      },
    },
    {
      id: "certified-positive",
      meta: {
        lastReason: "PUBLISHED_INCOMPLETE",
        continuationReady: true,
        frontierSnapshot: { pending: 400 },
      },
    },
  ],
  [activeContinuation]
);
ok(
  positiveWithContinuationRunning?.id === "certified-positive",
  "positive proof stays in the certification lane even with a resumable frontier"
);
const positiveRecallFirst = sortDueRetryEntries([
  {
    id: "neutral-zero-attempt",
    meta: { lastReason: "RECERTIFICATION_REQUIRED", attempts: 0 },
  },
  {
    id: "published-two-attempts",
    meta: { lastReason: "PUBLISHED_CURRENT", attempts: 2 },
  },
  {
    id: "generic-zero-attempt",
    meta: { lastReason: "RETRY_PENDING", attempts: 0 },
  },
]);
ok(
  positiveRecallFirst.map((entry) => entry.id).join(",") ===
    "published-two-attempts,neutral-zero-attempt,generic-zero-attempt",
  "positive historical evidence is re-fetched before neutral archive work"
);
const stalePositiveCannotStarveGeneral = sortDueRetryEntries([
  {
    id: "ambiguous-positive-many-attempts",
    meta: { lastReason: "SELF_INSURANCE_VERIFIED", attempts: 31 },
  },
  {
    id: "untouched-general",
    meta: { lastReason: "RETRY_PENDING", attempts: 0 },
  },
]);
ok(
  stalePositiveCannotStarveGeneral[0].id === "untouched-general",
  "non-certifiable positive loses its recall boost after two attempts"
);
const incompleteDual = selectDualOutcome(
  {
    token: "HOT",
    processingState: "HOT_VERIFIED",
    crawlComplete: true,
    policyFound: false,
    negativeIdentityCertified: true,
    siteCoverageCertified: true,
  },
  {
    token: null,
    processingState: "RETRY_PENDING",
    crawlComplete: false,
    policyFound: false,
    reasonCode: "FRONTIER_INCOMPLETE",
  }
);
ok(
  incompleteDual.kind === "incomplete",
  "partial second HOT pass resumes instead of becoming a false disagreement"
);
const blockedContinuationOrder = sortDueRetryEntries([
  {
    id: "blocked-only",
    meta: {
      lastReason: "FRONTIER_INCOMPLETE",
      continuationReady: false,
      nextRetryAt: "2026-07-20T00:00:00Z",
      lastAttemptAt: "2026-07-23T00:00:00Z",
    },
  },
  {
    id: "ready",
    meta: {
      lastReason: "FRONTIER_INCOMPLETE",
      continuationReady: true,
      nextRetryAt: "2026-07-22T00:00:00Z",
      lastAttemptAt: "2026-07-22T00:00:00Z",
    },
  },
]);
ok(
  blockedContinuationOrder[0].id === "ready",
  "blocked-only frontier cannot hot-loop ahead of workable continuation"
);
ok(
  new Date(nextRetryAt(1, { immediate: true, delayMs: 0 })).getTime() <=
    Date.now() + 50,
  "frontier continuation can reclaim its worker slot immediately"
);

const cls = classifyResult({ processingState: "RETRY_PENDING", newVerdict: null });
ok(cls.kind === "retry", "classify retry");
const clsT = classifyResult({
  processingState: "PUBLISHED_EXPIRED",
  newVerdict: "PUBLISHED",
  crawlComplete: true,
  policyFound: true,
  entityAttributionCertified: true,
});
ok(clsT.kind === "terminal", "classify published terminal");
ok(
  classifyResult({
    processingState: "PUBLISHED_CURRENT",
    newVerdict: "PUBLISHED",
    crawlComplete: true,
    policyFound: true,
  }).kind === "retry",
  "published_without_isolated_resource_attribution_is_recertified"
);
ok(
  classifyResult({
    processingState: "PUBLISHED_DATE_UNKNOWN",
    newVerdict: "PUBLISHED",
    token: "PUBLISHED",
    crawlComplete: false,
    policyFound: true,
    entityAttributionCertified: true,
    fullEvidence:
      "[V:PUB] [IDENTITY:OFFICIAL_CONFIRMED] [ATTR_RESOURCE_ISOLATED:1] " +
      "[DOCS: https://clinic.example/polizza.jpg] [CRAWL_COMPLETE:false]",
  }).kind === "terminal",
  "certified_positive_resource_can_publish_while_unrelated_frontier_remains_open"
);
ok(
  classifyResult({
    processingState: "PUBLISHED_DATE_UNKNOWN",
    newVerdict: "PUBLISHED",
    token: "PUBLISHED",
    crawlComplete: false,
    policyFound: true,
    entityAttributionCertified: true,
    fullEvidence:
      "[V:PUB] [ATTR_RESOURCE_ISOLATED:1] [DOCS: https://third-party.example/polizza.jpg]",
  }).kind === "retry",
  "incomplete_positive_without_official_identity_stays_retryable"
);
ok(
  classifyResult({
    processingState: "PUBLISHED_INCOMPLETE",
    newVerdict: "PUBLISHED",
    crawlComplete: true,
    policyFound: true,
    entityAttributionCertified: true,
  }).kind === "retry",
  "published_incomplete_is_not_a_commercial_terminal"
);
const strongIncompletePublication = classifyResult({
  processingState: "PUBLISHED_INCOMPLETE",
  newVerdict: "PUBLISHED",
  token: "PUBLISHED",
  crawlComplete: false,
  policyFound: true,
  policyNumber: "HC00K0IJ2440",
  entityAttributionCertified: true,
  fullEvidence:
    "[V:PUB] [PS:PUBLISHED_INCOMPLETE] [IDENTITY:OFFICIAL_CONFIRMED] " +
    "[ATTR_RESOURCE_ISOLATED:1] [DOCS: https://clinic.example/assicurazioni] " +
    "Polizza n. HC00K0IJ2440 Responsabilita Civile verso Terzi.",
});
ok(
  strongIncompletePublication.kind === "terminal" &&
    strongIncompletePublication.state === "PUBLISHED_DATE_UNKNOWN",
  "official policy with identifier closes as date-unknown even when optional details are missing"
);
const alignedExpired = alignCertifiedTerminalResult(
  {
    processingState: "PUBLISHED_CURRENT",
    businessVerdict: "PUBLISHED_CURRENT",
    fullEvidence:
      "[STATE:PUBLISHED_CURRENT][PS:PUBLISHED_CURRENT][BV:PUBLISHED_CURRENT]",
  },
  "PUBLISHED_EXPIRED",
  "2026-07-27T16:00:00Z"
);
ok(
  alignedExpired.changed &&
    alignedExpired.row.processingState === "PUBLISHED_EXPIRED" &&
    alignedExpired.row.businessVerdict === "PUBLISHED_EXPIRED" &&
    !/PUBLISHED_CURRENT/.test(alignedExpired.row.fullEvidence),
  "terminal_result_is_atomically_aligned_with_expired_classification"
);
ok(
  classifyResult(
    {
      processingState: "PUBLISHED_CURRENT",
      newVerdict: "PUBLISHED",
      crawlComplete: true,
      policyFound: true,
      policyExpiry: "2025-12-31",
      entityAttributionCertified: true,
    },
    { now: "2026-07-27T12:00:00Z" }
  ).state === "PUBLISHED_EXPIRED",
  "published_current_with_past_expiry_is_normalized_to_expired"
);
const dualHotProof = {
  token: "HOT",
  processingState: "HOT_VERIFIED",
  crawlComplete: true,
  policyFound: false,
  negativeIdentityCertified: true,
  siteCoverageCertified: true,
};
const dualPublishedProof = {
  token: "PUBLISHED",
  processingState: "PUBLISHED_DATE_UNKNOWN",
  crawlComplete: true,
  policyFound: true,
};
ok(
  selectDualOutcome(dualHotProof, dualPublishedProof).kind === "published",
  "positive_published_proof_wins_over_hot_absence"
);
ok(
  selectDualOutcome(dualHotProof, dualHotProof).kind === "hot",
  "hot_still_requires_two_certified_absence_passes"
);
ok(
  selectDualOutcome(dualHotProof, {
    ...dualPublishedProof,
    crawlComplete: false,
  }).kind === "incomplete",
  "incomplete_positive_pass_cannot_publish"
);
ok(
  classifyResult({
    processingState: "HOT_VERIFIED",
    newVerdict: "HOT",
    crawlComplete: true,
  }).kind === "retry",
  "hot_without_dual_proof_is_retried"
);
ok(
  classifyResult({
    processingState: "REVIEW_HUMAN",
    newVerdict: "REVIEW",
    crawlComplete: true,
  }).kind === "retry",
  "review_is_not_a_permanent_terminal"
);
ok(
  classifyResult({
    processingState: "PUBLISHED_DATE_UNKNOWN",
    newVerdict: "PUBLISHED",
    crawlComplete: true,
    policyFound: false,
    entityAttributionCertified: true,
  }).kind === "retry",
  "published_without_policy_found_is_retried"
);
ok(
  classifyResult({
    processingState: "SELF_INSURANCE_VERIFIED",
    newVerdict: "PUBLISHED",
    crawlComplete: true,
    policyFound: true,
    entityAttributionCertified: true,
    fullEvidence:
      "La struttura non ha sottoscritto polizza ma opera sotto il regime di autoassicurazione.",
  }).kind === "terminal",
  "explicit_self_insurance_is_terminal"
);
ok(
  classifyResult({
    processingState: "SELF_INSURANCE_VERIFIED",
    newVerdict: "PUBLISHED",
    crawlComplete: true,
    policyFound: true,
    entityAttributionCertified: true,
    fullEvidence:
      "Il dato si riferisce al periodo in cui la struttura è in copertura assicurativa o in autoassicurazione.",
  }).kind === "retry",
  "ambiguous_self_insurance_template_is_retried"
);
ok(
  classifyResult({
    processingState: "SELF_INSURANCE_VERIFIED",
    newVerdict: "PUBLISHED",
    crawlComplete: true,
    policyFound: true,
    entityAttributionCertified: true,
    fullEvidence:
      "Delibera sul programma regionale per la gestione diretta dei sinistri nelle Aziende Sanitarie sperimentatrici.",
  }).kind === "retry",
  "third_party_normative_self_insurance_reference_is_retried"
);
ok(
  classifyResult({
    processingState: "SELF_INSURANCE_VERIFIED",
    newVerdict: "PUBLISHED",
    token: "PUBLISHED",
    crawlComplete: false,
    policyFound: true,
    entityAttributionCertified: true,
    fullEvidence:
      "[V:PUB] [PS:SELF_INSURANCE_VERIFIED] [IDENTITY:OFFICIAL_CONFIRMED] " +
      "[ATTR_RESOURCE_ISOLATED:1] [DOCS: https://clinic.example/pars.pdf] " +
      "[SITE_COVERAGE_V3:0:open_nodes_138] " +
      "La struttura ha deciso di operare in regime di autoassicurazione e pertanto " +
      "ad oggi è presente un fondo sinistri.",
  }).kind === "terminal" &&
    classifyResult({
      processingState: "SELF_INSURANCE_VERIFIED",
      newVerdict: "PUBLISHED",
      token: "PUBLISHED",
      crawlComplete: false,
      policyFound: true,
      entityAttributionCertified: true,
      fullEvidence:
        "[V:PUB] [PS:SELF_INSURANCE_VERIFIED] [IDENTITY:OFFICIAL_CONFIRMED] " +
        "[ATTR_RESOURCE_ISOLATED:1] [DOCS: https://clinic.example/pars.pdf] " +
        "[SITE_COVERAGE_V3:0:open_nodes_138] " +
        "La struttura ha deciso di operare in regime di autoassicurazione e pertanto " +
        "ad oggi è presente un fondo sinistri.",
    }).state === "SELF_INSURANCE_VERIFIED",
  "certified_self_insurance_can_close_while_unrelated_frontier_remains_open"
);
ok(
  classifyResult({
    processingState: "SELF_INSURANCE_VERIFIED",
    newVerdict: "PUBLISHED",
    crawlComplete: false,
    policyFound: true,
    entityAttributionCertified: true,
    fullEvidence:
      "[V:PUB] [ATTR_RESOURCE_ISOLATED:1] [DOCS: https://clinic.example/pars.pdf] " +
      "La struttura opera sotto il regime di autoassicurazione.",
  }).kind === "retry",
  "self_insurance_without_official_identity_stays_retryable_even_if_incomplete"
);
ok(
  classifyResult({
    processingState: "SELF_INSURANCE_VERIFIED",
    newVerdict: "PUBLISHED",
    token: "PUBLISHED",
    crawlComplete: false,
    policyFound: true,
    entityAttributionCertified: true,
    fullEvidence:
      "[V:PUB] [PS:SELF_INSURANCE_VERIFIED] [STATE:SELF_INSURANCE_VERIFIED] " +
      "[BV:SELF_INSURANCE_VERIFIED] [VS:CURRENT_VERIFIED] " +
      "[SELF_INSURANCE_CITATION:hieste medesime ha deciso di operare in regime di autoassicurazione " +
      "e pertanto ad oggi e presente un fondo sinistri] " +
      "[IDENTITY:OFFICIAL_CONFIRMED] [ATTR_RESOURCE_ISOLATED:1] " +
      "[DOCS: https://www.clinicasantanna.it/sites/default/files/Modulistica/Pars_2025.pdf] " +
      "[CRAWL_COMPLETE:false] [FRONTIER:OPEN,p=1] " +
      "delle richieste medesime ha deciso di operare in regime di autoassicurazione " +
      "e pertanto ad oggi e presente un fondo sinistri di euro cinquecentomila.",
  }).kind === "terminal",
  "self_insurance_tags_must_not_trip_ambiguous_se_guard"
);
ok(
  classifyResult({
    processingState: "SELF_INSURANCE_VERIFIED",
    newVerdict: "PUBLISHED",
    token: "PUBLISHED",
    crawlComplete: false,
    policyFound: true,
    entityAttributionCertified: true,
    fullEvidence:
      "[V:PUB] [PS:SELF_INSURANCE_VERIFIED] [IDENTITY:OFFICIAL_CONFIRMED] " +
      "[ATTR_RESOURCE_ISOLATED:1] [DOCS: https://clinic.example/pars.pdf] " +
      "La gestione dei sinistri e degli eventi avversi avviene in particolare in autoassicurazione.",
  }).kind === "terminal",
  "first-party report explicitly managing claims in self-insurance is terminal"
);
ok(
  classifyResult({
    processingState: "HOT_VERIFIED",
    newVerdict: "HOT",
    crawlComplete: false,
    policyFound: false,
    fullEvidence: "[SITE_COVERAGE_V3:0:open_nodes_10] [CRAWL_COMPLETE:false]",
  }).kind === "retry",
  "hot_still_cannot_close_while_frontier_incomplete"
);
ok(
  buildWorkerNodeOptions("--trace-warnings --max-old-space-size=3072", 1536) ===
    "--trace-warnings --max-old-space-size=1536",
  "worker_heap_limit_replaces_larger_duplicate"
);
ok(
  buildWorkerNodeOptions("--max-old-space-size 3072 --trace-warnings", 1024) ===
    "--trace-warnings --max-old-space-size=1024",
  "worker_heap_limit_normalizes_space_form"
);

const recertCp = emptyCheckpointV3("d".repeat(40));
recertCp.terminal.legacyHot = {
  processingState: "HOT_VERIFIED",
  newVerdict: "HOT",
  reasonCode: "HOT_VERIFIED",
};
recertCp.attempts.legacyHot = 8;
fs.writeFileSync(
  path.join(resultsDir, "legacyHot.json"),
  JSON.stringify({
    id: "legacyHot",
    schemaVersion: 3,
    fullEvidence:
      "[STATE:HOT_VERIFIED][CRAWL_COMPLETE:true][NEGATIVE_IDENTITY_V2:1][SITE_COVERAGE_V3:1]",
    processingState: "HOT_VERIFIED",
    newVerdict: "HOT",
    crawlComplete: true,
    pass1: {
      runId: "run-1",
      frontierPath: "/tmp/frontier.sqlite",
      processingState: "HOT_VERIFIED",
      crawlComplete: true,
      policyFound: false,
      negativeIdentityCertified: true,
    },
    pass2: null,
  })
);
const recert = reconcileTerminalCertifications(recertCp, resultsDir);
ok(recert.demoted.length === 1, "legacy_hot_without_pass2_is_demoted");
ok(!recertCp.terminal.legacyHot, "invalid_terminal_is_removed");
ok(
  recertCp.retryQueue.legacyHot?.frontierPath === "/tmp/frontier.sqlite" &&
    recertCp.retryQueue.legacyHot?.forceDue === true,
  "recertification_resumes_existing_frontier"
);
const recertRow = JSON.parse(
  fs.readFileSync(path.join(resultsDir, "legacyHot.json"), "utf8")
);
ok(
  recertRow.processingState === "RETRY_PENDING" &&
    recertRow.previousProcessingState === "HOT_VERIFIED",
  "demoted_result_is_no_longer_commercial"
);

const normalizedCp = emptyCheckpointV3("e".repeat(40));
normalizedCp.terminal.certifiedHot = {
  processingState: "REVIEW_HUMAN",
  newVerdict: "REVIEW",
  reasonCode: "DUAL_HOT_DISAGREE",
};
fs.writeFileSync(
  path.join(resultsDir, "certifiedHot.json"),
  JSON.stringify({
    id: "certifiedHot",
    schemaVersion: 3,
    fullEvidence:
      "[STATE:HOT_VERIFIED][CRAWL_COMPLETE:true][NEGATIVE_IDENTITY_V2:1][SITE_COVERAGE_V3:1]",
    processingState: "HOT_VERIFIED",
    newVerdict: "HOT",
    reasonCode: "HOT_VERIFIED",
    crawlComplete: true,
    pass1: {
      processingState: "HOT_VERIFIED",
      crawlComplete: true,
      policyFound: false,
      negativeIdentityCertified: true,
      siteCoverageCertified: true,
    },
    pass2: {
      processingState: "HOT_VERIFIED",
      crawlComplete: true,
      policyFound: false,
      negativeIdentityCertified: true,
      siteCoverageCertified: true,
    },
  })
);
const normalized = reconcileTerminalCertifications(normalizedCp, resultsDir);
ok(
  normalized.normalized.length === 1 &&
    normalizedCp.terminal.certifiedHot?.processingState === "HOT_VERIFIED",
  "stale_terminal_metadata_is_normalized_from_certified_result"
);

const stalePublishedCp = emptyCheckpointV3("f".repeat(40));
stalePublishedCp.terminal.stalePublished = {
  processingState: "PUBLISHED_CURRENT",
  newVerdict: "PUBLISHED",
  reasonCode: "PUBLISHED_CURRENT",
};
fs.writeFileSync(
  path.join(resultsDir, "stalePublished.json"),
  JSON.stringify({
    id: "stalePublished",
    schemaVersion: 3,
    fullEvidence:
      "[V:PUB][STATE:PUBLISHED_CURRENT][PS:PUBLISHED_CURRENT][BV:PUBLISHED_CURRENT][CRAWL_COMPLETE:true]",
    evidence: "[PS:PUBLISHED_CURRENT] polizza RC",
    processingState: "PUBLISHED_CURRENT",
    publishedSubtype: "PUBLISHED_CURRENT",
    newVerdict: "PUBLISHED",
    reasonCode: "PUBLISHED_CURRENT",
    crawlComplete: true,
    policyFound: true,
    entityAttributionCertified: true,
    policyExpiry: "2000-01-01",
  })
);
const stalePublished = reconcileTerminalCertifications(
  stalePublishedCp,
  resultsDir
);
const stalePublishedRow = JSON.parse(
  fs.readFileSync(path.join(resultsDir, "stalePublished.json"), "utf8")
);
ok(
  stalePublished.normalized.length === 1 &&
    stalePublishedCp.terminal.stalePublished?.processingState ===
      "PUBLISHED_EXPIRED",
  "checkpoint_with_past_expiry_is_normalized_to_expired"
);
ok(
  stalePublishedRow.processingState === "PUBLISHED_EXPIRED" &&
    stalePublishedRow.businessVerdict === "PUBLISHED_EXPIRED" &&
    stalePublishedRow.publishedSubtype === "PUBLISHED_EXPIRED" &&
    /\[PS:PUBLISHED_EXPIRED\]/.test(stalePublishedRow.fullEvidence) &&
    /\[BV:PUBLISHED_EXPIRED\]/.test(stalePublishedRow.fullEvidence) &&
    !/PUBLISHED_CURRENT/.test(stalePublishedRow.fullEvidence),
  "result_and_ui_tokens_are_rewritten_to_expired"
);

// restart preserves retry schedule
const cpPath = path.join(tmp, "checkpoint.json");
saveCheckpointAtomic(cpPath, mig.checkpoint);
const reloaded = JSON.parse(fs.readFileSync(cpPath, "utf8"));
ok(reloaded.retryQueue[five[0]]?.nextRetryAt != null, "restart_preserves_retry_schedule");

// result full evidence + atomic write
const out = path.join(resultsDir, "full.json");
const row = writeResultAtomic(out, {
  id: "full",
  fullEvidence: "[V:HOT][STATE:HOT_VERIFIED] complete",
  processingState: "HOT_VERIFIED",
  schemaVersion: 3,
  policyFound: false,
  policyCompany: null,
  policyNumber: null,
  policyExpiry: null,
  policyMassimale: null,
});
ok(resultHasRequiredFields(row), "result_contains_full_evidence");
ok("policyNumber" in row && "policyExpiry" in row && "policyMassimale" in row, "result_contains_all_policy_fields");
ok(fs.existsSync(out) && !fs.existsSync(out + ".tmp"), "result_write_is_atomic");
ok(Boolean(row.contentHash || row.resultHash), "result_hash_is_reproducible field present");
ok(!resultHasRequiredFields({ id: "x", processingState: "HOT_VERIFIED" }), "partial_result_is_rejected");

// worker isolation contracts (static)
const parent = fs.readFileSync("scripts/production-revalidate-sanita-v3.mjs", "utf8");
const worker = fs.readFileSync("scripts/production-revalidate-sanita-worker.mjs", "utf8");
ok(!/from \"\.\/.*scan-engine|await import\(.*scan-engine/.test(parent), "parent_does_not_import_scan-engine");
ok(!/openFrontierStore\s*\(/.test(parent), "parent_no_openFrontierStore call");
ok(!/await import\([^\)]*frontier-store/.test(parent), "parent_no_frontier_store_import");
ok(/Never imports analyzeLead \/ openFrontierStore/.test(parent), "parent_documents_no_frontier");
ok(/Never imports analyzeLead|never import analyzeLead|Spawns isolated/i.test(parent), "parent_scheduler_isolation_documented");
ok(/FRONTIER_DB_PATH/.test(worker) && /REVALIDATE_LEAD_ID/.test(worker), "env_isolated_between_workers contract");
ok(
  /entityAttributionCertified:\s*\/\\\[ATTR_RESOURCE_ISOLATED:1/.test(worker),
  "worker_persists_isolated_resource_attribution_proof"
);
ok(
  /negativeIdentityCertified:\s*\/\\\[NEGATIVE_IDENTITY_V2:1/.test(worker),
  "worker_persists_current_negative_identity_proof"
);
ok(
  /siteCoverageCertified:\s*\/\\\[SITE_COVERAGE_V3:1/.test(worker),
  "worker_persists_exhaustive_site_coverage_proof"
);
ok(/acquireLeadLock|\.lock/.test(parent), "same_lead_cannot_run_twice");
ok(/spawn\(/.test(parent), "two_workers_use_different_frontiers via spawn");
ok(/inProgress/.test(parent) && /IN_PROGRESS_INTERRUPTED|parent_restart/.test(parent), "parent_restart_resumes_in_progress_leads");
ok(/DUAL_HOT|needsDual|HOT_VERIFIED/.test(parent), "only_complete_hot_gets_second_pass");
ok(
  /previousProcessingState[\s\S]*processingState:\s*"RETRY_PENDING"/.test(parent),
  "nonterminal_worker_state_is_persisted_as_retry"
);
ok(
  !/attempts\s*>=\s*MAX_RETRY_ATTEMPTS[\s\S]{0,80}return\s+false/.test(parent),
  "retry_attempt_ceiling_never_parks_a_lead"
);
ok(
  /dual_hot_resume_pass2/.test(parent) &&
    /lastRunId:\s*retryRunId[\s\S]*frontierPath:\s*retryFrontierPath[\s\S]*passLabel:\s*retryPassLabel/.test(parent),
  "interrupted_dual_hot_resumes_pass2_frontier"
);
ok(
  /identityFresh[\s\S]*strategy === "fresh"[\s\S]*IDENTITY/.test(parent) &&
    /forceIdentityRediscovery[\s\S]*REVALIDATE_RETRY_STRATEGY === "fresh"/.test(
      fs.readFileSync("src/lib/sanita/scan-engine.ts", "utf8")
    ),
  "identity_retry_rediscovers_website_on_a_fresh_frontier"
);
ok(
  /alignCertifiedTerminalResult\(finalRow,\s*cls\.state\)/.test(parent),
  "parent_rewrites_terminal_result_before_checkpoint_commit"
);
ok(
  /pass1:\s*pass1\.pass1\s*\|\|\s*pass1/.test(parent),
  "dual_result_never_drops_pass1_proof"
);
ok(TERMINAL_STATES.has("OUT_OF_SCOPE"), "OUT_OF_SCOPE terminal");

// apply uses fullEvidence
const apply = fs.readFileSync("scripts/production-apply-revalidation.mjs", "utf8");
ok(/fullEvidence/.test(apply) && !/after\.evidence,\s*\/\//.test(apply), "shadow_full_evidence_is_copied_to_live");
ok(/CRM_MISMATCH|status,\s*notes/.test(apply), "crm_status_and_notes_are_preserved");
ok(/missing fullEvidence|resultHasRequiredFields/.test(apply), "missing_full_evidence_blocks_apply");
ok(
  /terminal_results_reclassify_same[\s\S]*classifyResult\(row\)/.test(apply),
  "apply_revalidates_every_terminal_against_current_contract"
);
ok(/LIVE_DATABASE_URL|datasources/.test(apply), "live_old_evidence_is_not_reused as source");

console.log(
  JSON.stringify({
    suite: "revalidation-v3",
    exitCode: fail === 0 ? 0 : 1,
    pass,
    fail,
    durationMs: Date.now() - start,
  }, null, 2)
);
process.exit(fail === 0 ? 0 : 1);
