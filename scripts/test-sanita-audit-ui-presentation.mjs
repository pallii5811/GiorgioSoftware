/**
 * Presentation-only: audit badges + includeAll semantics (no DB).
 * Run: node scripts/test-sanita-audit-ui-presentation.mjs
 */
import assert from "node:assert/strict";
import { auditQueueBadge, AUDIT_BADGE_UI } from "../src/lib/sanita/audit-queue-badge.ts";

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

check("actionable → no badge", () => {
  assert.equal(auditQueueBadge({ actionable: true, evidence: "x" }), null);
});

check("RETRY_PENDING → RETRY", () => {
  assert.equal(
    auditQueueBadge({
      evidence: "[STATE:RETRY_PENDING]",
      _actionable: false,
    }),
    "RETRY"
  );
  assert.match(AUDIT_BADGE_UI.RETRY.label, /RETRY TECNICO/);
});

check("TECHNICAL_BLOCKED → TECHNICAL", () => {
  assert.equal(
    auditQueueBadge({
      evidence: "[STATE:TECHNICAL_BLOCKED]",
      semantic: { actionable: false },
    }),
    "TECHNICAL"
  );
});

check("REVIEW_HUMAN → REVIEW_IDENTITY", () => {
  assert.equal(
    auditQueueBadge({
      evidence: "[STATE:REVIEW_HUMAN]",
      _actionable: false,
    }),
    "REVIEW_IDENTITY"
  );
});

check("legacy evidence → LEGACY or IN_REVALIDATION", () => {
  const b = auditQueueBadge({
    evidence: "Analisi vecchia senza marker evidenza corrente",
    _actionable: false,
  });
  assert.ok(b === "LEGACY" || b === "IN_REVALIDATION", `got ${b}`);
});

check("labels required by product", () => {
  assert.equal(AUDIT_BADGE_UI.LEGACY.label, "LEGACY — NON CERTIFICATO");
  assert.equal(AUDIT_BADGE_UI.IN_REVALIDATION.label, "IN RIVALIDAZIONE");
  assert.equal(AUDIT_BADGE_UI.RETRY.label, "RETRY TECNICO");
  assert.equal(AUDIT_BADGE_UI.REVIEW_IDENTITY.label, "REVIEW IDENTITÀ");
  assert.equal(AUDIT_BADGE_UI.TECHNICAL.label, "BLOCCO TECNICO");
});

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll presentation checks PASS");
