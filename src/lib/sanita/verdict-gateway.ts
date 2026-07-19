/**
 * VerdictGateway — unico ingresso persistenza verdette Sanità.
 * Valida state machine + canEmit* prima di qualsiasi write.
 */
import type { Verdict } from "@/lib/sanita/verdict";
import { canEmitHot, explainCanEmitHot, type HotEmitEvidence } from "@/lib/sanita/can-emit-hot";
import {
  canEmitPublished,
  type PublishedEmitEvidence,
} from "@/lib/sanita/can-emit-published";
import {
  stampProcessingMeta,
  type BusinessVerdict,
  type SanitaProcessingState,
  type ValidationStatus,
} from "@/lib/sanita/processing-state";
import { HotIncompleteStopError, HOT_INCOMPLETE_STOP } from "@/lib/sanita/atomic-verdict";

export class PublishedGateError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`PUBLISHED gate failed: ${reasons.join("; ")}`);
    this.name = "PublishedGateError";
    this.reasons = reasons;
  }
}

export class VerdictGatewayRejectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerdictGatewayRejectError";
  }
}

export type PersistSanitaInput = {
  legacyVerdict: Verdict;
  evidenceBody: string;
  hotEvidence?: HotEmitEvidence;
  publishedEvidence?: PublishedEmitEvidence;
  businessVerdict?: BusinessVerdict;
  validationStatus?: ValidationStatus;
  processingState?: SanitaProcessingState;
};

export type PersistSanitaDecision = {
  allowed: true;
  legacyVerdict: Verdict;
  evidenceBody: string;
  businessVerdict: BusinessVerdict;
  validationStatus: ValidationStatus;
  processingState: SanitaProcessingState;
};

/**
 * Valida e prepara il payload da persistere. Non scrive sul DB.
 * Caller esegue la transazione solo se allowed.
 */
export function prepareSanitaVerdictPersist(input: PersistSanitaInput): PersistSanitaDecision {
  const legacy = input.legacyVerdict;
  let body = input.evidenceBody;
  let bv = input.businessVerdict ?? "NONE";
  let vs = input.validationStatus ?? "CURRENT_VERIFIED";
  let state = input.processingState ?? "DOCUMENT_VALIDATION";

  if (legacy === "HOT") {
    if (!input.hotEvidence) {
      throw new VerdictGatewayRejectError("HOT without hotEvidence");
    }
    const hot = explainCanEmitHot(input.hotEvidence);
    if (!hot.ok || !canEmitHot(input.hotEvidence)) {
      throw new HotIncompleteStopError(hot.reasons);
    }
    bv = "HOT_VERIFIED";
    state = "HOT_VERIFIED";
    vs = "CURRENT_VERIFIED";
  }

  if (legacy === "PUBLISHED") {
    if (input.publishedEvidence) {
      const pub = canEmitPublished(input.publishedEvidence);
      if (!pub.ok) throw new PublishedGateError(pub.reasons);
      bv = pub.businessVerdict ?? bv;
      state = (pub.businessVerdict as SanitaProcessingState) ?? "PUBLISHED_CURRENT";
      vs = "CURRENT_VERIFIED";
    } else if (vs === "LEGACY_EVIDENCE" || vs === "REVALIDATION_PENDING") {
      // Conservazione storica: niente canEmitPublished obbligatorio
      if (!bv.startsWith("PUBLISHED")) bv = "PUBLISHED_DATE_UNKNOWN";
      if (!String(state).startsWith("PUBLISHED") && state !== "RETRY_PENDING" && state !== "TECHNICAL_BLOCKED") {
        state = "PUBLISHED_DATE_UNKNOWN";
      }
    } else {
      throw new PublishedGateError(["publishedEvidence richiesto per CURRENT_VERIFIED"]);
    }
  }

  if (legacy === "REVIEW" && state === "RETRY_PENDING") {
    // RETRY_PENDING non è REVIEW_HUMAN
    bv = bv === "NONE" ? "NONE" : bv;
  }

  if (state === "REVIEW_HUMAN") bv = "REVIEW_HUMAN";

  body = stampProcessingMeta(body, {
    state,
    businessVerdict: bv,
    validationStatus: vs,
  });

  return {
    allowed: true,
    legacyVerdict: legacy,
    evidenceBody: body,
    businessVerdict: bv,
    validationStatus: vs,
    processingState: state,
  };
}

export { HOT_INCOMPLETE_STOP };
