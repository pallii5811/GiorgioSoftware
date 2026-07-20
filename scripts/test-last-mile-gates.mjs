/**
 * Last-mile gates — regional hint ordering, terminal counters, completeness invariant.
 */
import {
  captureRegionalHint,
  applyRegionalHintAfterFinalCompleteness,
  isOfficialRegionalPolicyDocument,
} from "../src/lib/sanita/regional-hint.ts";
import {
  resolveTerminalProcessing,
  stampCompletenessMarkers,
  assertCompletenessInvariant,
  readCrawlCompleteFromEvidence,
} from "../src/lib/sanita/terminal-processing.ts";
import { buildFrontierFromCrawl } from "../src/lib/sanita/crawl-frontier-ledger.ts";
import { deriveCrawlComplete } from "../src/lib/evidence/contract.ts";
import { finalizeVerdict } from "../src/lib/sanita/finalize-verdict.ts";
import { presentSanitaLead } from "../src/lib/sanita/present-sanita-lead.ts";
import { HotIncompleteStopError } from "../src/lib/sanita/atomic-verdict.ts";

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

const incomplete = deriveCrawlComplete({
  ...complete,
  relevantDocumentsProcessed: false,
  unreadableRelevantDocuments: 1,
  complete: false,
});

const regionalFull = {
  policyFound: true,
  checked: true,
  evidence: "Polizza RC Unipol documento ufficiale portale ASL",
  company: "Unipol",
  policyNumber: "123",
  expiry: null,
  sourceUrls: ["https://asl.example/doc.pdf"],
  queryCount: 1,
  confidence: 0.9,
  massimale: null,
  checkedAt: new Date(),
  contactsFromPortals: { emails: [], pec: null, phones: [], website: null },
};

// regional_hint_before_identity_cannot_downgrade — generic hint + incomplete must not human-conflict
{
  const genericRegional = {
    ...regionalFull,
    company: null,
    policyNumber: null,
    evidence: "menzione generica portale",
  };
  const hint = captureRegionalHint(genericRegional);
  const adjStale = applyRegionalHintAfterFinalCompleteness({
    candidateVerdict: "HOT",
    policyFoundOnSite: false,
    policyObsolete: false,
    identityVerified: true,
    finalComplete: false,
    hint,
    regionalFull: genericRegional,
  });
  ok(adjStale.verdict === "REVIEW" && !adjStale.humanConflict, "regional_hint_before_identity_cannot_downgrade");
  const adjFinal = applyRegionalHintAfterFinalCompleteness({
    candidateVerdict: "HOT",
    policyFoundOnSite: false,
    policyObsolete: false,
    identityVerified: true,
    finalComplete: true,
    hint,
    regionalFull: { ...regionalFull, company: null, policyNumber: null, evidence: "menzione generica portale" },
  });
  ok(adjFinal.verdict === "HOT", "complete_first_party_absence_keeps_hot");
}

// official_regional_policy_document_creates_conflict
{
  const adj = applyRegionalHintAfterFinalCompleteness({
    candidateVerdict: "HOT",
    policyFoundOnSite: false,
    policyObsolete: false,
    identityVerified: true,
    finalComplete: true,
    hint: captureRegionalHint(regionalFull),
    regionalFull,
  });
  ok(adj.verdict === "REVIEW" && adj.humanConflict, "official_regional_policy_document_creates_conflict");
  ok(isOfficialRegionalPolicyDocument(regionalFull), "official doc detector");
}

ok(
  applyRegionalHintAfterFinalCompleteness({
    candidateVerdict: "HOT",
    policyFoundOnSite: false,
    policyObsolete: false,
    identityVerified: true,
    finalComplete: false,
    hint: captureRegionalHint(regionalFull),
    regionalFull,
  }).verdict !== "HOT",
  "incomplete_first_party_with_regional_hint_not_hot"
);

// clean_run_heidy_regional_path — hint only, no early REVIEW
{
  const hintOnly = captureRegionalHint({
    ...regionalFull,
    policyFound: true,
    evidence: "snippet portale",
    company: null,
    policyNumber: null,
  });
  const adj = applyRegionalHintAfterFinalCompleteness({
    candidateVerdict: "HOT",
    policyFoundOnSite: false,
    policyObsolete: false,
    identityVerified: true,
    finalComplete: true,
    hint: hintOnly,
    regionalFull: { ...regionalFull, company: null, policyNumber: null, evidence: "snippet portale" },
  });
  ok(adj.verdict === "HOT" && !adj.humanConflict, "clean_run_heidy_regional_path");
}

// terminal counters
{
  const retry = resolveTerminalProcessing({
    legacyVerdict: "REVIEW",
    gatewayDecision: null,
    finProcessingHint: "RETRY_PENDING",
    ocrTechReason: "",
    identityStatus: "INSUFFICIENT_TECHNICAL",
    finalComplete: false,
    crawlOk: true,
    humanConflict: false,
  });
  ok(retry.counterKind === "retryPending" && retry.packAsRetry, "retry_pending_counter_only_once");
  ok(retry.businessVerdict === "NONE", "retry_pending_uses_retry_packer");

  const tech = resolveTerminalProcessing({
    legacyVerdict: "REVIEW",
    gatewayDecision: null,
    finProcessingHint: null,
    ocrTechReason: "OCR_RENDERER_MISSING",
    identityStatus: "INSUFFICIENT_TECHNICAL",
    finalComplete: false,
    crawlOk: true,
    humanConflict: false,
  });
  ok(tech.counterKind === "technicalBlocked", "technical_blocked_counter_only_once");

  const human = resolveTerminalProcessing({
    legacyVerdict: "REVIEW",
    gatewayDecision: null,
    finProcessingHint: "REVIEW_HUMAN",
    ocrTechReason: "",
    identityStatus: "MISMATCH",
    finalComplete: true,
    crawlOk: true,
    humanConflict: true,
  });
  ok(human.counterKind === "reviewHuman", "technical_never_increments_review_human (human only on conflict)");
  ok(retry.counterKind !== "reviewHuman", "review_human_never_increments_retry");
  ok(human.processingState === "REVIEW_HUMAN", "one_terminal_state_per_lead human");
}

// completeness invariant
{
  const frontier = buildFrontierFromCrawl({
    baseUrl: "https://x.it",
    pagesVisited: ["https://x.it/"],
    policyPdfsQueued: 0,
    policyPdfsRead: 0,
    needsOcrReview: false,
    completeness: complete,
  });
  const stamped = stampCompletenessMarkers("body", "OFFICIAL_CONFIRMED", true);
  ok(readCrawlCompleteFromEvidence(stamped) === true, "evidence_complete_equals_frontier_complete");
  ok(frontier.frontierExhausted === true, "frontier complete");
  let threw = false;
  try {
    assertCompletenessInvariant(true, frontier, true);
  } catch {
    threw = true;
  }
  ok(!threw, "invariant pass when aligned");

  const badFrontier = buildFrontierFromCrawl({
    baseUrl: "https://x.it",
    pagesVisited: ["https://x.it/"],
    policyPdfsQueued: 2,
    policyPdfsRead: 0,
    needsOcrReview: false,
    completeness: incomplete,
  });
  try {
    assertCompletenessInvariant(true, badFrontier, false);
    ok(false, "stale_complete_cannot_emit_hot");
  } catch (e) {
    ok(e?.name === "HotIncompleteStopError" || e instanceof HotIncompleteStopError, "stale_complete_cannot_emit_hot");
  }
  ok(!badFrontier.frontierExhausted, "waterfall_pending_node_invalidates_complete");
}

// marigold regression — marker true but frontier open
{
  const marigoldIncomplete = deriveCrawlComplete({
    ...complete,
    relevantDocumentsProcessed: false,
    unreadableRelevantDocuments: 1,
  });
  const frontier = buildFrontierFromCrawl({
    baseUrl: "http://dimora.it",
    pagesVisited: ["http://dimora.it/"],
    policyPdfsQueued: 9,
    policyPdfsRead: 8,
    needsOcrReview: false,
    completeness: marigoldIncomplete,
  });
  ok(!frontier.frontierExhausted, "marigold_inconsistent_complete_regression frontier open");
  const semantic = presentSanitaLead({
    id: "m",
    companyName: "Dimora",
    evidence: stampCompletenessMarkers("x", "OFFICIAL_CONFIRMED", false),
    lastScannedAt: new Date(),
    website: "http://dimora.it",
  });
  ok(semantic.crawlComplete === false, "presenter_complete_equals_frontier_complete");
}

// finalizeVerdict technical not human for incomplete
{
  const fin = finalizeVerdict({
    verdict: "HOT",
    evidenceBody: "x",
    pagesVisited: 20,
    websiteReachable: true,
    website: "https://x.it",
    policyExhaustive: true,
    needsOcrReview: false,
    identityStatus: "INSUFFICIENT_TECHNICAL",
    category: "RSA",
    crawlCompleteness: incomplete,
  });
  ok(fin.processingHint === "RETRY_PENDING", "technical identity → RETRY not REVIEW_HUMAN");
}

console.log(
  JSON.stringify(
    { suite: "last-mile-gates", exitCode: fail === 0 ? 0 : 1, durationMs: Date.now() - start, pass, fail },
    null,
    2
  )
);
process.exit(fail === 0 ? 0 : 1);
