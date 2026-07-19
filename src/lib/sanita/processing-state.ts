/**
 * Macchina a stati Sanità — separa business, validazione e coda UI.
 */

export type SanitaProcessingState =
  | "DISCOVERED"
  | "SCOPE_RESOLUTION"
  | "IDENTITY_RESOLUTION"
  | "SITE_RESOLUTION"
  | "CRAWL_RUNNING"
  | "DOCUMENT_VALIDATION"
  | "RETRY_PENDING"
  | "TECHNICAL_BLOCKED"
  | "REVIEW_HUMAN"
  | "PUBLISHED_CURRENT"
  | "PUBLISHED_EXPIRED"
  | "PUBLISHED_DATE_UNKNOWN"
  | "PUBLISHED_INCOMPLETE"
  | "PUBLISHED_ANALOGOUS_MEASURE"
  | "HOT_VERIFIED"
  | "OUT_OF_SCOPE";

export type BusinessVerdict =
  | "PUBLISHED_CURRENT"
  | "PUBLISHED_EXPIRED"
  | "PUBLISHED_DATE_UNKNOWN"
  | "PUBLISHED_INCOMPLETE"
  | "PUBLISHED_ANALOGOUS_MEASURE"
  | "HOT_VERIFIED"
  | "REVIEW_HUMAN"
  | "OUT_OF_SCOPE"
  | "NONE";

export type ValidationStatus =
  | "LEGACY_EVIDENCE"
  | "CURRENT_VERIFIED"
  | "REVALIDATION_PENDING"
  | "TECHNICAL_BLOCKED"
  | "CONFLICT_FOUND";

/** Stati esclusi dalla coda commerciale cliente. */
export const HIDDEN_FROM_COMMERCIAL_UI: ReadonlySet<SanitaProcessingState> = new Set([
  "DISCOVERED",
  "SCOPE_RESOLUTION",
  "IDENTITY_RESOLUTION",
  "SITE_RESOLUTION",
  "CRAWL_RUNNING",
  "DOCUMENT_VALIDATION",
  "RETRY_PENDING",
  "TECHNICAL_BLOCKED",
  "OUT_OF_SCOPE",
]);

const STATE_RE = /\[STATE:([A-Z_]+)\]/i;
const BV_RE = /\[BV:([A-Z_]+)\]/i;
const VS_RE = /\[VS:([A-Z_]+)\]/i;

export function readProcessingState(evidence: string | null | undefined): SanitaProcessingState | null {
  const m = evidence?.match(STATE_RE);
  return m ? (m[1]!.toUpperCase() as SanitaProcessingState) : null;
}

export function readBusinessVerdict(evidence: string | null | undefined): BusinessVerdict | null {
  const m = evidence?.match(BV_RE);
  return m ? (m[1]!.toUpperCase() as BusinessVerdict) : null;
}

export function readValidationStatus(evidence: string | null | undefined): ValidationStatus | null {
  const m = evidence?.match(VS_RE);
  return m ? (m[1]!.toUpperCase() as ValidationStatus) : null;
}

export function stampProcessingMeta(
  body: string,
  opts: {
    state?: SanitaProcessingState;
    businessVerdict?: BusinessVerdict;
    validationStatus?: ValidationStatus;
  }
): string {
  let out = body
    .replace(STATE_RE, "")
    .replace(BV_RE, "")
    .replace(VS_RE, "")
    .trim();
  if (opts.state) out = `${out} [STATE:${opts.state}]`.trim();
  if (opts.businessVerdict) out = `${out} [BV:${opts.businessVerdict}]`.trim();
  if (opts.validationStatus) out = `${out} [VS:${opts.validationStatus}]`.trim();
  return out;
}

export function isCommercialUiVisible(state: SanitaProcessingState | null): boolean {
  if (!state) return true; // legacy without state token
  return !HIDDEN_FROM_COMMERCIAL_UI.has(state);
}

/** Errori tecnici → RETRY_PENDING (mai REVIEW_HUMAN al primo colpo). */
export function isTechnicalTransientError(err: string | null | undefined): boolean {
  if (!err) return false;
  return /timeout|timed?\s*out|403|429|5\d\d|ECONNRESET|ENOTFOUND|DNS|SSL|CERT|WAF|captcha|browser\s*crash|net::/i.test(
    err
  );
}

/**
 * Preserva business PUB storico se il nuovo passaggio è solo tecnico.
 * Non degrada a REVIEW_HUMAN.
 */
export function resolveAfterTechnicalFailure(input: {
  previousEvidence: string | null | undefined;
  error: string;
  retriesExhausted: boolean;
}): {
  keepLegacyToken: "PUBLISHED" | "HOT" | "REVIEW" | null;
  state: SanitaProcessingState;
  businessVerdict: BusinessVerdict;
  validationStatus: ValidationStatus;
} {
  const prevBv = readBusinessVerdict(input.previousEvidence);
  const histPub =
    /^\[V:PUB\]/i.test(input.previousEvidence || "") ||
    (prevBv != null && prevBv.startsWith("PUBLISHED"));

  if (histPub) {
    const bv =
      prevBv && prevBv.startsWith("PUBLISHED")
        ? prevBv
        : ("PUBLISHED_DATE_UNKNOWN" as BusinessVerdict);
    if (input.retriesExhausted) {
      return {
        keepLegacyToken: "PUBLISHED",
        state: "TECHNICAL_BLOCKED",
        businessVerdict: bv,
        validationStatus: "TECHNICAL_BLOCKED",
      };
    }
    return {
      keepLegacyToken: "PUBLISHED",
      state: "RETRY_PENDING",
      businessVerdict: bv,
      validationStatus: "REVALIDATION_PENDING",
    };
  }

  if (input.retriesExhausted) {
    return {
      keepLegacyToken: "REVIEW",
      state: "TECHNICAL_BLOCKED",
      businessVerdict: "REVIEW_HUMAN",
      validationStatus: "TECHNICAL_BLOCKED",
    };
  }
  return {
    keepLegacyToken: null,
    state: "RETRY_PENDING",
    businessVerdict: "NONE",
    validationStatus: "REVALIDATION_PENDING",
  };
}
