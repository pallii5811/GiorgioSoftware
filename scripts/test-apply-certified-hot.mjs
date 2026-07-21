/**
 * Apply progressivo HOT — gate canonico + negativi.
 * Run: npx tsx scripts/test-apply-certified-hot.mjs
 */
import assert from "node:assert/strict";
import {
  validateHotApply,
  validatePublishedApply,
} from "../src/lib/sanita/apply-certified-terminal.ts";

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}:`, e.message);
  }
}

const HOT_EV =
  "[V:HOT] cert [STATE:HOT_VERIFIED][BV:HOT_VERIFIED][VS:CURRENT_VERIFIED][IDENTITY:OFFICIAL_CONFIRMED] [CRAWL_COMPLETE:true] [EV_V:2 VD_V:2 LEGACY:CURRENT]";

const goodDual = {
  id: "h1",
  processingState: "HOT_VERIFIED",
  newVerdict: "HOT",
  fullEvidence: HOT_EV,
  dualDisagreement: false,
  website: "https://clinica.example",
  websiteReachable: true,
  pagesVisited: 20,
  category: "Casa di cura",
  crawlComplete: true,
  policyExhaustive: true,
  needsOcrReview: false,
  pass1: {
    token: "HOT",
    processingState: "HOT_VERIFIED",
    crawlComplete: true,
    policyFound: false,
    runId: "run-a",
  },
  pass2: {
    token: "HOT",
    processingState: "HOT_VERIFIED",
    crawlComplete: true,
    policyFound: false,
    runId: "run-b",
  },
  runIds: ["run-a", "run-b"],
};

check("hot_dual_agree_passes_canonical_gate", () => {
  const r = validateHotApply(goodDual);
  assert.equal(r.ok, true);
});

check("manual_hot_state_stamp_rejected_without_dual", () => {
  const r = validateHotApply({
    ...goodDual,
    pass1: null,
    pass2: null,
    dualDisagreement: false,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "hot_dual_gate_failed");
});

check("timeout_reason_rejected", () => {
  const r = validateHotApply({
    ...goodDual,
    reasonCode: "TIMEOUT_LOCK",
    error: "timeout",
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "hot_unresolved_error");
});

check("ocr_failed_rejected", () => {
  const r = validateHotApply({
    ...goodDual,
    needsOcrReview: true,
    fullEvidence: `${HOT_EV} [OCR:REVIEW]`,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "hot_canonical_gate_failed");
});

check("unreachable_site_rejected", () => {
  const r = validateHotApply({
    ...goodDual,
    websiteReachable: false,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "hot_canonical_gate_failed");
});

check("identity_mismatch_rejected", () => {
  const r = validateHotApply({
    ...goodDual,
    fullEvidence: HOT_EV.replace("OFFICIAL_CONFIRMED", "INSUFFICIENT"),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "hot_canonical_gate_failed");
});

check("single_pass_rejected", () => {
  const r = validateHotApply({
    ...goodDual,
    pass2: null,
  });
  assert.equal(r.ok, false);
});

check("dual_disagreement_rejected", () => {
  const r = validateHotApply({
    ...goodDual,
    dualDisagreement: true,
    pass2: { ...goodDual.pass2, token: "REVIEW" },
  });
  assert.equal(r.ok, false);
});

check("legacy_evidence_rejected", () => {
  const r = validateHotApply({
    ...goodDual,
    fullEvidence: "[V:HOT] vecchio senza EV_V",
  });
  assert.equal(r.ok, false);
});

check("published_apply_still_ok", () => {
  const ev =
    "[V:PUB] ok [STATE:PUBLISHED_CURRENT][BV:PUBLISHED_CURRENT][VS:CURRENT_VERIFIED] [CRAWL_COMPLETE:true] [EV_V:2 VD_V:2 LEGACY:CURRENT]";
  const r = validatePublishedApply({
    id: "p1",
    processingState: "PUBLISHED_CURRENT",
    newVerdict: "PUBLISHED",
    fullEvidence: ev,
  });
  assert.equal(r.ok, true);
});

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll apply-certified-hot tests PASS");
