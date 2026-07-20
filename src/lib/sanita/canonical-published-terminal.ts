/**
 * Accept PUBLISHED_* terminals only from analyzeLead-aligned stamps.
 * Reuses canEmitPublished for evidence shape checks — does NOT invent PUB from prose.
 */
import { canEmitPublished, type PublishedEmitEvidence } from "@/lib/sanita/can-emit-published";
import type { BusinessVerdict, SanitaProcessingState } from "@/lib/sanita/processing-state";
import type { Verdict } from "@/lib/sanita/verdict";

export type CanonicalPublishedInput = {
  token: Verdict | string | null | undefined;
  businessVerdict: BusinessVerdict | string | null | undefined;
  processingState: SanitaProcessingState | string | null | undefined;
  policyFound: boolean | null | undefined;
  policyExpiry: Date | string | null | undefined;
  evidence: string;
  workerError?: string | null;
  runAt?: Date;
  /** Optional full gateway evidence — when present, canEmitPublished is required ok. */
  publishedEvidence?: PublishedEmitEvidence | null;
};

export type CanonicalPublishedResult =
  | { ok: true; processingState: SanitaProcessingState; businessVerdict: BusinessVerdict }
  | { ok: false; reasons: string[] };

function parseExpiry(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * PUBLISHED_EXPIRED (and other PUBLISHED_*) terminal acceptance for coordinators.
 * Never promotes HOT / REVIEW prose into PUBLISHED.
 */
export function acceptCanonicalPublishedTerminal(input: CanonicalPublishedInput): CanonicalPublishedResult {
  const reasons: string[] = [];
  if (input.workerError) reasons.push("worker_error");

  const token = (input.token || "").toString().toUpperCase();
  const bv = (input.businessVerdict || "").toString().toUpperCase() as BusinessVerdict;
  let state = (input.processingState || "").toString().toUpperCase() as SanitaProcessingState;
  const evidence = input.evidence || "";

  if (token !== "PUBLISHED") reasons.push(`token_not_published(${token || "null"})`);
  if (!String(bv).startsWith("PUBLISHED")) reasons.push(`bv_not_published(${bv || "null"})`);

  // Engine inconsistency: PUB token + PUB BV but RETRY_PENDING state → refuse (engine must align)
  if (state === "RETRY_PENDING" && token === "PUBLISHED" && String(bv).startsWith("PUBLISHED")) {
    reasons.push("engine_inconsistency_published_with_retry_pending");
  }

  if (!state || !String(state).startsWith("PUBLISHED")) {
    // Allow BV to define state only when already a PUBLISHED_* stamp and token is PUBLISHED
    if (token === "PUBLISHED" && String(bv).startsWith("PUBLISHED") && state !== "RETRY_PENDING") {
      state = bv as SanitaProcessingState;
    } else {
      reasons.push(`state_not_published(${state || "null"})`);
    }
  }

  if (String(state).startsWith("PUBLISHED") && String(bv).startsWith("PUBLISHED") && state !== bv) {
    reasons.push(`state_bv_mismatch(${state}!=${bv})`);
  }

  if (/IDENTITY:MISMATCH|Contaminazione critica|sito errato/i.test(evidence)) {
    reasons.push("identity_mismatch");
  }
  if (/\[VS:CONFLICT_FOUND\]|conflitto critico/i.test(evidence)) {
    reasons.push("critical_conflict");
  }

  if (bv === "PUBLISHED_EXPIRED" || state === "PUBLISHED_EXPIRED") {
    if (input.policyFound !== true) reasons.push("policy_found_not_true");
    const exp = parseExpiry(input.policyExpiry);
    const runAt = input.runAt || new Date();
    if (!exp) reasons.push("missing_expiry");
    else if (exp.getTime() >= runAt.getTime()) reasons.push("expiry_not_before_run");
  }

  if (input.publishedEvidence) {
    const gate = canEmitPublished(input.publishedEvidence);
    if (!gate.ok) reasons.push(...gate.reasons.map((r) => `gate:${r}`));
    else if (gate.businessVerdict && bv && gate.businessVerdict !== bv) {
      reasons.push(`gate_bv_mismatch(${gate.businessVerdict}!=${bv})`);
    }
  }

  if (reasons.length) return { ok: false, reasons };

  return {
    ok: true,
    processingState: state,
    businessVerdict: bv,
  };
}

/**
 * Scan-engine guard: PUBLISHED gateway decision must not be packed as RETRY_PENDING.
 */
export function alignPublishedTerminalState(opts: {
  legacyVerdict: Verdict | string;
  processingState: SanitaProcessingState;
  businessVerdict: BusinessVerdict;
  packAsRetry: boolean;
}): { processingState: SanitaProcessingState; businessVerdict: BusinessVerdict; packAsRetry: boolean } {
  const v = opts.legacyVerdict;
  const bv = opts.businessVerdict;
  let state = opts.processingState;
  let packAsRetry = opts.packAsRetry;

  if (v === "PUBLISHED" && String(bv).startsWith("PUBLISHED")) {
    if (state === "RETRY_PENDING" || packAsRetry) {
      state = bv as SanitaProcessingState;
      packAsRetry = false;
    }
    if (!String(state).startsWith("PUBLISHED")) {
      state = bv as SanitaProcessingState;
      packAsRetry = false;
    }
  }
  return { processingState: state, businessVerdict: bv, packAsRetry };
}
