/**
 * Gates for published-priority delivery — no false PUB from legacy alone, no HOT on tech fail.
 * Run: npx tsx scripts/test-published-priority-gates.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { acceptCanonicalPublishedTerminal } from "../src/lib/sanita/canonical-published-terminal.ts";
import { canEmitPublished } from "../src/lib/sanita/can-emit-published.ts";
import { runPublishedFastPath } from "../src/lib/sanita/published-fast-path.ts";
import { isInActionableSalesQueue } from "../src/lib/sanita/actionable-queue.ts";

let failed = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      throw new Error("use checkAsync for async");
    }
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}:`, e.message);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}:`, e.message);
  }
}

check("old_published_token_alone_does_not_pass_canonical", () => {
  const r = acceptCanonicalPublishedTerminal({
    token: "PUBLISHED",
    businessVerdict: null,
    processingState: "RETRY_PENDING",
    policyFound: true,
    policyExpiry: null,
    evidence: "[V:PUB] vecchio senza gateway",
  });
  assert.equal(r.ok, false);
});

check("policyFound_false_expired_does_not_pass", () => {
  const past = new Date(Date.now() - 86400000 * 400);
  const r = acceptCanonicalPublishedTerminal({
    token: "PUBLISHED",
    businessVerdict: "PUBLISHED_EXPIRED",
    processingState: "PUBLISHED_EXPIRED",
    policyFound: false,
    policyExpiry: past,
    evidence: "[V:PUB]",
  });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => /policy_found/i.test(x)));
});

check("other_facility_source_rejected_by_canEmit", () => {
  const d = canEmitPublished({
    identityStatus: "OFFICIAL_CONFIRMED",
    sourceClass: "THIRD_PARTY_DIRECTORY",
    exactUrl: "https://paginegialle.it/foo.pdf",
    contentFetched: true,
    contentExcerpt: "polizza n. 12345 RCT massimale",
    entityAttributed: false,
    hasStrongInsuranceSignal: true,
    hasMediumInsuranceSignals: 3,
    category: "Casa di cura",
  });
  assert.equal(d.ok, false);
});

check("legacy_evidence_not_in_commercial_queue", () => {
  assert.equal(
    isInActionableSalesQueue({
      type: "HEALTHCARE",
      evidence: "[V:PUB] polizza storica senza EV_V",
      lastScannedAt: new Date(),
    }),
    false
  );
});

check("current_published_evidence_can_be_actionable", () => {
  const ev =
    "[V:PUB] ok [STATE:PUBLISHED_CURRENT][BV:PUBLISHED_CURRENT][VS:CURRENT_VERIFIED] [CRAWL_COMPLETE:true] [EV_V:2 VD_V:2 LEGACY:CURRENT]";
  assert.equal(
    isInActionableSalesQueue({ type: "HEALTHCARE", evidence: ev, lastScannedAt: new Date() }),
    true
  );
});

check("worker_source_has_published_priority_mode", () => {
  const src = fs.readFileSync(
    path.join("scripts", "production-revalidate-sanita-worker.mjs"),
    "utf8"
  );
  assert.match(src, /REVALIDATE_MODE === "published-priority"/);
  assert.match(src, /published_priority_hot_forbidden|Never HOT/);
  assert.match(src, /runPublishedFastPath/);
});

check("apply_certified_uses_canonical_hot_gate", () => {
  const src = fs.readFileSync(
    path.join("scripts", "production-apply-certified-lead.mjs"),
    "utf8"
  );
  assert.match(src, /validateCertifiedApplyRow/);
  assert.match(src, /apply-certified-terminal/);
  assert.match(src, /CRM_MISMATCH/);
});

await checkAsync("apply_hot_gate_module_exports_validator", async () => {
  const { validateHotApply } = await import("../src/lib/sanita/apply-certified-terminal.ts");
  const r = validateHotApply({
    id: "bad",
    processingState: "HOT_VERIFIED",
    newVerdict: "HOT",
    fullEvidence: "[V:HOT] fake [STATE:HOT_VERIFIED][BV:HOT_VERIFIED][VS:CURRENT_VERIFIED] [CRAWL_COMPLETE:true] [IDENTITY:OFFICIAL_CONFIRMED] [EV_V:2 VD_V:2 LEGACY:CURRENT]",
    dualDisagreement: false,
    website: "https://x.it",
    websiteReachable: true,
    pagesVisited: 20,
    category: "Casa di cura",
    crawlComplete: true,
    policyExhaustive: true,
    pass1: { token: "HOT", processingState: "HOT_VERIFIED", crawlComplete: true, policyFound: false },
    pass2: null,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "hot_dual_gate_failed");
});

await checkAsync("unreachable_pdf_fast_path_never_hot", async () => {
  const fp = await runPublishedFastPath({
    leadId: "t1",
    companyName: "Clinica Test",
    website: "https://clinicatest.example",
    category: "Casa di cura",
    evidence: "[V:PUB] [DOCS: https://clinicatest.example/missing-polizza.pdf]",
    identityStatus: "OFFICIAL_CONFIRMED",
  });
  assert.notEqual(fp.processingState, "HOT_VERIFIED");
  assert.equal(fp.publishedOk, false);
});

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll published-priority gates PASS");
