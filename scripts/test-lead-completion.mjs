/**
 * Deterministic tests for evaluateLeadCompletion — the single completeness gate.
 * Every product-illegal terminal must be impossible; every legal terminal reproducible.
 * Run: npx tsx scripts/test-lead-completion.mjs
 */
import assert from "node:assert/strict";
import {
  evaluateLeadCompletion,
  IDENTITY_CONFIDENCE_GATE,
} from "../src/lib/sanita/lead-completion.ts";

const FUTURE = new Date(Date.now() + 180 * 86400_000).toISOString();
const PAST = new Date(Date.now() - 180 * 86400_000).toISOString();
const HASH = "a".repeat(64);

function completeFrontier(over = {}) {
  return {
    identityVerified: true,
    sitemapExhausted: true,
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
    complete: true,
    ...over,
  };
}

function baseHot(over = {}) {
  return {
    identityStatus: "OFFICIAL_CONFIRMED",
    identityConfidence: 0.95,
    category: "CASA_DI_CURA",
    website: "https://example.it/",
    websiteReachable: true,
    pagesVisited: 20,
    policyExhaustive: true,
    needsOcrReview: false,
    crawlCompleteness: completeFrontier(),
    secondPassConfirmed: true,
    published: null,
    ...over,
  };
}

function publishedEvidence(over = {}) {
  return {
    identityStatus: "OFFICIAL_CONFIRMED",
    sourceClass: "FIRST_PARTY_FACILITY",
    exactUrl: "https://example.it/documenti/polizza.pdf",
    contentFetched: true,
    contentExcerpt: "Polizza RC professionale n. 12345 compagnia UnipolSai scadenza 31/12/2026",
    entityAttributed: true,
    groupSeatVerified: true,
    hasStrongInsuranceSignal: true,
    hasMediumInsuranceSignals: 3,
    criticalConflict: false,
    category: "CASA_DI_CURA",
    ...over,
  };
}

function basePublished(over = {}) {
  return baseHot({
    published: publishedEvidence(),
    policyDocumentHash: HASH,
    policyEvidencePersisted: true,
    policyExpiry: FUTURE,
    // HOT-only requirements are irrelevant when policy evidence exists,
    // but keep them satisfied to isolate published-gate behavior per case.
    ...over,
  });
}

let n = 0;
function t(name, fn) {
  n++;
  try {
    fn();
    console.log(`  PASS ${n}. ${name}`);
  } catch (e) {
    console.error(`  FAIL ${n}. ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

console.log("=== test: lead-completion (evaluateLeadCompletion) ===");

// ---------- PUBLISHED ----------
t("PUBLISHED_CURRENT quando scadenza futura", () => {
  const r = evaluateLeadCompletion(basePublished());
  assert.equal(r.complete, true);
  assert.equal(r.outcome, "PUBLISHED_CURRENT");
});

t("PUBLISHED_EXPIRED quando scadenza passata", () => {
  const r = evaluateLeadCompletion(basePublished({ policyExpiry: PAST }));
  assert.equal(r.complete, true);
  assert.equal(r.outcome, "PUBLISHED_EXPIRED");
});

t("PUBLISHED_DATE_UNKNOWN quando scadenza assente", () => {
  const r = evaluateLeadCompletion(basePublished({ policyExpiry: null }));
  assert.equal(r.complete, true);
  assert.equal(r.outcome, "PUBLISHED_DATE_UNKNOWN");
});

t("PUBLISHED senza hash SHA-256 documento → MAI terminale", () => {
  const r = evaluateLeadCompletion(basePublished({ policyDocumentHash: null }));
  assert.equal(r.complete, false);
  assert.equal(r.reasonCode, "PUBLISHED_GATE_FAILED");
  assert.ok(r.reasons.some((x) => /hash/i.test(x)));
});

t("PUBLISHED con evidence non persistita → MAI terminale", () => {
  const r = evaluateLeadCompletion(basePublished({ policyEvidencePersisted: false }));
  assert.equal(r.complete, false);
});

t("PUBLISHED con technicalFailures>0 → MAI terminale", () => {
  const r = evaluateLeadCompletion(
    basePublished({ crawlCompleteness: completeFrontier({ failedRelevantUrls: 1, complete: false }) })
  );
  assert.equal(r.complete, false);
});

t("PUBLISHED con identità non terminale → MAI terminale", () => {
  const r = evaluateLeadCompletion(
    basePublished({ identityStatus: "UNKNOWN", published: publishedEvidence({ identityStatus: "UNKNOWN" }) })
  );
  assert.equal(r.complete, false);
});

t("PUBLISHED senza URL esatto → gate fallisce, MAI degradato a HOT", () => {
  const r = evaluateLeadCompletion(
    basePublished({ published: publishedEvidence({ exactUrl: null }) })
  );
  assert.equal(r.complete, false);
  assert.equal(r.outcome, null); // non HOT, non PUB
  assert.equal(r.reasonCode, "PUBLISHED_GATE_FAILED");
});

t("identityConfidence sotto gate → PUBLISHED impossibile", () => {
  const r = evaluateLeadCompletion(basePublished({ identityConfidence: IDENTITY_CONFIDENCE_GATE - 0.01 }));
  assert.equal(r.complete, false);
});

// ---------- HOT ----------
t("HOT_VERIFIED con frontier completa + dual pass + identità certa", () => {
  const r = evaluateLeadCompletion(baseHot());
  assert.equal(r.complete, true);
  assert.equal(r.outcome, "HOT_VERIFIED");
});

t("HOT impossibile con unresolvedRelevantNodes > 0", () => {
  const r = evaluateLeadCompletion(
    baseHot({ crawlCompleteness: completeFrontier({ unresolvedRelevantUrls: 2, complete: false }) })
  );
  assert.equal(r.complete, false);
  assert.ok(r.reasons.some((x) => /irrisolti/i.test(x)));
});

t("HOT impossibile con unprocessedRelevantPdfs > 0", () => {
  const r = evaluateLeadCompletion(
    baseHot({ crawlCompleteness: completeFrontier({ unreadableRelevantDocuments: 1, complete: false }) })
  );
  assert.equal(r.complete, false);
  assert.ok(r.reasons.some((x) => /PDF rilevanti non processati/i.test(x)));
});

t("HOT impossibile con technicalFailures > 0", () => {
  const r = evaluateLeadCompletion(
    baseHot({ crawlCompleteness: completeFrontier({ failedRelevantUrls: 1, complete: false }) })
  );
  assert.equal(r.complete, false);
  assert.equal(r.reasonCode, "TECHNICAL_FAILURES");
});

t("HOT impossibile con ocrErrors > 0", () => {
  const r = evaluateLeadCompletion(
    baseHot({ crawlCompleteness: completeFrontier({ criticalOcrDoubts: 1, complete: false }) })
  );
  assert.equal(r.complete, false);
});

t("HOT impossibile con identityConfidence sotto gate", () => {
  const r = evaluateLeadCompletion(baseHot({ identityConfidence: 0.5 }));
  assert.equal(r.complete, false);
});

t("HOT impossibile senza seconda verifica indipendente", () => {
  const r = evaluateLeadCompletion(baseHot({ secondPassConfirmed: false }));
  assert.equal(r.complete, false);
  assert.equal(r.reasonCode, "DUAL_PASS_PENDING");
});

t("HOT impossibile con pagine < MIN_PAGES_FOR_HOT", () => {
  const r = evaluateLeadCompletion(baseHot({ pagesVisited: 5 }));
  assert.equal(r.complete, false);
});

t("HOT impossibile con needsOcrReview", () => {
  const r = evaluateLeadCompletion(baseHot({ needsOcrReview: true }));
  assert.equal(r.complete, false);
});

t("HOT impossibile con crawl non esaustivo", () => {
  const r = evaluateLeadCompletion(baseHot({ policyExhaustive: false }));
  assert.equal(r.complete, false);
});

t("HOT impossibile con sitemap NON risolta", () => {
  const r = evaluateLeadCompletion(
    baseHot({ crawlCompleteness: completeFrontier({ sitemapStatus: "NOT_DISCOVERED", sitemapExhausted: false, complete: false }) })
  );
  assert.equal(r.complete, false);
  assert.equal(r.reasonCode, "SITEMAP_UNRESOLVED");
});

t("completeness assente (null) → nessun terminale possibile", () => {
  const r = evaluateLeadCompletion(baseHot({ crawlCompleteness: null }));
  assert.equal(r.complete, false);
});

t("reasonCode FRONTIER_INCOMPLETE su coda non esaurita", () => {
  const r = evaluateLeadCompletion(
    baseHot({ crawlCompleteness: completeFrontier({ htmlQueueExhausted: false, unresolvedRelevantUrls: 3, complete: false }) })
  );
  assert.equal(r.complete, false);
  assert.equal(r.reasonCode, "FRONTIER_INCOMPLETE");
});

console.log(`\n${n} tests, exit=${process.exitCode || 0}`);
process.exit(process.exitCode || 0);
