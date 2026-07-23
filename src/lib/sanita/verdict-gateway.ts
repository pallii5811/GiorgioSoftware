/**
 * VerdictGateway — unico ingresso persistenza verdette Sanità.
 * Valida state machine + canEmit* prima di qualsiasi write.
 */
import type { Verdict } from "@/lib/sanita/verdict";
import { canEmitHot, explainCanEmitHot, type HotEmitEvidence } from "@/lib/sanita/can-emit-hot";
import {
  canEmitPublished,
  detectInsuranceSignals,
  type PublishedEmitEvidence,
} from "@/lib/sanita/can-emit-published";
import {
  stampProcessingMeta,
  type BusinessVerdict,
  type SanitaProcessingState,
  type ValidationStatus,
} from "@/lib/sanita/processing-state";
import { HotIncompleteStopError, HOT_INCOMPLETE_STOP } from "@/lib/sanita/atomic-verdict";
import { classifyFetchedAgainstFacility, type SourceClass } from "@/lib/sanita/source-class";
import { canAttributeEntity, type EntityFingerprint } from "@/lib/sanita/entity-fingerprint";

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
 * Costruisce PublishedEmitEvidence dal percorso scan (unico ingresso a canEmitPublished).
 */
export function buildPublishedEmitEvidence(opts: {
  identityStatus: PublishedEmitEvidence["identityStatus"];
  pageUrl: string | null | undefined;
  facilityWebsite: string | null | undefined;
  groupWebsite?: string | null;
  contentFetched: boolean;
  contentExcerpt: string | null | undefined;
  docFingerprint: EntityFingerprint;
  facilityFingerprint: EntityFingerprint;
  policyObsolete?: boolean;
  hasCoverageEnd?: boolean;
  incompletePublication?: boolean;
  analogousMeasure?: boolean;
  selfInsurance?: boolean;
  category?: string | null;
  criticalConflict?: boolean;
  sourceClassOverride?: SourceClass;
}): PublishedEmitEvidence {
  const sourceClass =
    opts.sourceClassOverride ??
    classifyFetchedAgainstFacility({
      pageUrl: opts.pageUrl || "",
      facilityWebsite: opts.facilityWebsite,
      groupWebsite: opts.groupWebsite,
    });
  const attr = canAttributeEntity(opts.docFingerprint, opts.facilityFingerprint);
  const sig = detectInsuranceSignals(opts.contentExcerpt || "");
  return {
    identityStatus: opts.identityStatus,
    sourceClass,
    exactUrl: opts.pageUrl,
    contentFetched: opts.contentFetched,
    contentExcerpt: opts.contentExcerpt,
    entityAttributed: attr.ok,
    attributionDetail: attr.ok
      ? undefined
      : `url=${opts.pageUrl || "null"} strong=${attr.strongIds.join("+") || 0} medium=${attr.mediumIds.join("+") || 0}`,
    groupSeatVerified: opts.facilityFingerprint.groupSeatVerified === true,
    hasStrongInsuranceSignal: sig.strong,
    hasMediumInsuranceSignals: sig.mediumCount,
    criticalConflict: opts.criticalConflict,
    policyObsolete: opts.policyObsolete,
    hasCoverageEnd: opts.hasCoverageEnd,
    incompletePublication: opts.incompletePublication,
    analogousMeasure: opts.analogousMeasure,
    selfInsurance: opts.selfInsurance,
    category: opts.category,
  };
}

/**
 * Valida e prepara il payload da persistere. Non scrive sul DB.
 * Caller esegue la transazione solo se allowed.
 * Unico percorso ammesso verso token terminali PUBLISHED / HOT_VERIFIED.
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
