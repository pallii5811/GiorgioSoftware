/**
 * Canonical PUBLISHED acceptance for revalidation worker — no prose→PUB invention.
 */
import assert from "node:assert/strict";
import {
  acceptCanonicalPublishedTerminal,
  alignPublishedTerminalState,
} from "../src/lib/sanita/canonical-published-terminal.ts";
import { canEmitPublished } from "../src/lib/sanita/can-emit-published.ts";

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

const past = new Date(Date.now() - 86400000 * 400);
const future = new Date(Date.now() + 86400000 * 400);

// docs_url_plus_word_scaduta_does_not_publish
{
  const r = acceptCanonicalPublishedTerminal({
    token: "HOT",
    businessVerdict: null,
    processingState: "RETRY_PENDING",
    policyFound: false,
    policyExpiry: null,
    evidence:
      "[V:HOT] Polizza RC pubblicata sul sito ma scaduta da 601 giorni — [DOCS: http://cardioprogress.it/wp-content/uploads/2026/04/polizza-assicurativa.pdf]",
  });
  ok(!r.ok, "docs_url_plus_word_scaduta_does_not_publish");
}

// expired_generic_document_does_not_publish
{
  const r = acceptCanonicalPublishedTerminal({
    token: "HOT",
    businessVerdict: "NONE",
    processingState: "RETRY_PENDING",
    policyFound: true,
    policyExpiry: past,
    evidence: "Documento generico scaduto [DOCS: https://example.com/doc.pdf] policyObsolete",
  });
  ok(!r.ok, "expired_generic_document_does_not_publish");
}

// parm_with_expired_reference_does_not_publish
{
  const r = acceptCanonicalPublishedTerminal({
    token: "REVIEW",
    businessVerdict: null,
    processingState: null,
    policyFound: false,
    policyExpiry: past,
    evidence: "PARM scaduto riferimento storico [DOCS: https://asl.example.it/parm.pdf] scaduta",
  });
  ok(!r.ok, "parm_with_expired_reference_does_not_publish");
}

// wrong_entity_expired_policy_does_not_publish
{
  const r = acceptCanonicalPublishedTerminal({
    token: "PUBLISHED",
    businessVerdict: "PUBLISHED_EXPIRED",
    processingState: "PUBLISHED_EXPIRED",
    policyFound: true,
    policyExpiry: past,
    evidence:
      "[V:PUB] [STATE:PUBLISHED_EXPIRED] [BV:PUBLISHED_EXPIRED] Contaminazione critica identità: Nome struttura assente [IDENTITY:MISMATCH]",
  });
  ok(!r.ok && r.reasons.includes("identity_mismatch"), "wrong_entity_expired_policy_does_not_publish");
}

// policy_found_false_cannot_publish
{
  const r = acceptCanonicalPublishedTerminal({
    token: "PUBLISHED",
    businessVerdict: "PUBLISHED_EXPIRED",
    processingState: "PUBLISHED_EXPIRED",
    policyFound: false,
    policyExpiry: past,
    evidence: "[V:PUB] [STATE:PUBLISHED_EXPIRED] [BV:PUBLISHED_EXPIRED] [DOCS: https://ok.it/p.pdf]",
  });
  ok(!r.ok && r.reasons.includes("policy_found_not_true"), "policy_found_false_cannot_publish");
}

// missing_expiry_cannot_be_published_expired
{
  const r = acceptCanonicalPublishedTerminal({
    token: "PUBLISHED",
    businessVerdict: "PUBLISHED_EXPIRED",
    processingState: "PUBLISHED_EXPIRED",
    policyFound: true,
    policyExpiry: null,
    evidence: "[V:PUB] [STATE:PUBLISHED_EXPIRED] [BV:PUBLISHED_EXPIRED]",
  });
  ok(!r.ok && r.reasons.includes("missing_expiry"), "missing_expiry_cannot_be_published_expired");
}

// canonical_published_expired_passes
{
  const gate = canEmitPublished({
    identityStatus: "OFFICIAL_CONFIRMED",
    sourceClass: "FIRST_PARTY_FACILITY",
    exactUrl: "https://clinic.example.it/trasparenza/polizza.pdf",
    contentFetched: true,
    contentExcerpt: "Numero polizza RC-1 Compagnia Unipol massimale € 5000000 scadenza 01/01/2024",
    entityAttributed: true,
    hasStrongInsuranceSignal: true,
    hasMediumInsuranceSignals: 3,
    policyObsolete: true,
    hasCoverageEnd: true,
    category: "Casa di cura",
  });
  ok(gate.ok && gate.businessVerdict === "PUBLISHED_EXPIRED", "gateway canEmitPublished expired");
  const r = acceptCanonicalPublishedTerminal({
    token: "PUBLISHED",
    businessVerdict: "PUBLISHED_EXPIRED",
    processingState: "PUBLISHED_EXPIRED",
    policyFound: true,
    policyExpiry: past,
    evidence:
      "[V:PUB] [STATE:PUBLISHED_EXPIRED] [BV:PUBLISHED_EXPIRED] [IDENTITY:OFFICIAL_CONFIRMED] [DOCS: https://clinic.example.it/trasparenza/polizza.pdf]",
    publishedEvidence: {
      identityStatus: "OFFICIAL_CONFIRMED",
      sourceClass: "FIRST_PARTY_FACILITY",
      exactUrl: "https://clinic.example.it/trasparenza/polizza.pdf",
      contentFetched: true,
      contentExcerpt: "Numero polizza RC-1 Compagnia Unipol massimale € 5000000 scadenza 01/01/2024",
      entityAttributed: true,
      hasStrongInsuranceSignal: true,
      hasMediumInsuranceSignals: 3,
      policyObsolete: true,
      hasCoverageEnd: true,
      category: "Casa di cura",
    },
  });
  ok(r.ok && r.processingState === "PUBLISHED_EXPIRED", "canonical_published_expired_passes");
}

// worker_cannot_override_canonical_verdict
{
  // Simulates pre-patch regex path inputs: HOT + scaduta + DOCS must NOT become PUBLISHED_EXPIRED
  const forged = acceptCanonicalPublishedTerminal({
    token: "HOT",
    businessVerdict: null,
    processingState: "RETRY_PENDING",
    policyFound: true,
    policyExpiry: past,
    evidence:
      "[V:HOT] Polizza RC pubblicata sul sito ma scaduta da 601 giorni — Art. 10 — [DOCS: http://cardioprogress.it/x.pdf] [STATE:RETRY_PENDING]",
  });
  ok(!forged.ok, "worker_cannot_override_canonical_verdict");
  // Engine align: PUB + BV expired must not stay RETRY
  const aligned = alignPublishedTerminalState({
    legacyVerdict: "PUBLISHED",
    processingState: "RETRY_PENDING",
    businessVerdict: "PUBLISHED_EXPIRED",
    packAsRetry: true,
  });
  ok(
    aligned.processingState === "PUBLISHED_EXPIRED" && aligned.packAsRetry === false,
    "engine_aligns_published_expired_away_from_retry_pending"
  );
}

// future expiry cannot be PUBLISHED_EXPIRED
{
  const r = acceptCanonicalPublishedTerminal({
    token: "PUBLISHED",
    businessVerdict: "PUBLISHED_EXPIRED",
    processingState: "PUBLISHED_EXPIRED",
    policyFound: true,
    policyExpiry: future,
    evidence: "[V:PUB] [STATE:PUBLISHED_EXPIRED] [BV:PUBLISHED_EXPIRED]",
  });
  ok(!r.ok && r.reasons.includes("expiry_not_before_run"), "future_expiry_rejected");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
