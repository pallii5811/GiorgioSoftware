/**
 * Single terminal processing state + counter for analyzeLead persistence.
 */
import type { CrawlCompleteness } from "@/lib/evidence/contract";
import type { CrawlFrontierLedger } from "@/lib/sanita/crawl-frontier-ledger";
import { HotIncompleteStopError } from "@/lib/sanita/atomic-verdict";
import type { PublishedSubtype } from "@/lib/sanita/published-subtype";
import type { IdentityStatus } from "@/lib/sanita/identity-evidence";
import type {
  BusinessVerdict,
  SanitaProcessingState,
  ValidationStatus,
} from "@/lib/sanita/processing-state";
import type { PersistSanitaDecision } from "@/lib/sanita/verdict-gateway";
import type { Verdict } from "@/lib/sanita/verdict";

export type TerminalCounterKind =
  | "published"
  | "hot"
  | "retryPending"
  | "technicalBlocked"
  | "reviewHuman"
  | "none";

export type TerminalResolution = {
  processingState: SanitaProcessingState;
  businessVerdict: BusinessVerdict;
  validationStatus: ValidationStatus;
  counterKind: TerminalCounterKind;
  packAsRetry: boolean;
};

export function resolveTerminalProcessing(opts: {
  legacyVerdict: Verdict;
  gatewayDecision: PersistSanitaDecision | null;
  finProcessingHint: "RETRY_PENDING" | "REVIEW_HUMAN" | null;
  ocrTechReason: string;
  identityStatus: IdentityStatus;
  finalComplete: boolean;
  crawlOk: boolean;
  humanConflict: boolean;
  publishedSubtype?: PublishedSubtype | null;
}): TerminalResolution {
  if (opts.gatewayDecision) {
    const g = opts.gatewayDecision;
    const counterKind: TerminalCounterKind =
      g.processingState === "HOT_VERIFIED"
        ? "hot"
        : String(g.processingState).startsWith("PUBLISHED")
          ? "published"
          : "none";
    return {
      processingState: g.processingState,
      businessVerdict: g.businessVerdict,
      validationStatus: g.validationStatus,
      counterKind,
      packAsRetry: false,
    };
  }

  if (opts.ocrTechReason) {
    return {
      processingState: "TECHNICAL_BLOCKED",
      businessVerdict: "NONE",
      validationStatus: "TECHNICAL_BLOCKED",
      counterKind: "technicalBlocked",
      packAsRetry: false,
    };
  }

  const technical =
    opts.finProcessingHint === "RETRY_PENDING" ||
    opts.identityStatus === "INSUFFICIENT_TECHNICAL" ||
    !opts.crawlOk ||
    !opts.finalComplete;

  if (technical && !opts.humanConflict) {
    return {
      processingState: "RETRY_PENDING",
      businessVerdict: "NONE",
      validationStatus: "REVALIDATION_PENDING",
      counterKind: "retryPending",
      packAsRetry: true,
    };
  }

  if (opts.humanConflict || opts.finProcessingHint === "REVIEW_HUMAN") {
    return {
      processingState: "REVIEW_HUMAN",
      businessVerdict: "REVIEW_HUMAN",
      validationStatus: "CONFLICT_FOUND",
      counterKind: "reviewHuman",
      packAsRetry: false,
    };
  }

  if (technical) {
    return {
      processingState: "RETRY_PENDING",
      businessVerdict: "NONE",
      validationStatus: "REVALIDATION_PENDING",
      counterKind: "retryPending",
      packAsRetry: true,
    };
  }

  return {
    processingState: "REVIEW_HUMAN",
    businessVerdict: "REVIEW_HUMAN",
    validationStatus: "REVALIDATION_PENDING",
    counterKind: "reviewHuman",
    packAsRetry: false,
  };
}

export function stripCompletenessMarkers(body: string): string {
  return body
    .replace(/\[IDENTITY:[^\]]+\]/gi, "")
    .replace(/\[CRAWL_COMPLETE:(true|false)\]/gi, "")
    .replace(/\[FRONTIER:[^\]]+\]/gi, "")
    .trim();
}

export function stampCompletenessMarkers(
  body: string,
  identityStatus: string,
  finalComplete: boolean
): string {
  const base = stripCompletenessMarkers(body);
  return `${base} [IDENTITY:${identityStatus}] [CRAWL_COMPLETE:${finalComplete}]`.trim();
}

/** evidence marker === frontier === persisted completeness (stop-ship). */
export function assertCompletenessInvariant(
  crawlCompleteMarker: boolean,
  frontier: CrawlFrontierLedger,
  persistedComplete: boolean
): void {
  const frontierOk = frontier.frontierExhausted === persistedComplete;
  const markerOk = crawlCompleteMarker === persistedComplete;
  if (!markerOk || !frontierOk) {
    throw new HotIncompleteStopError([
      `completeness invariant: marker=${crawlCompleteMarker} frontier=${frontier.frontierExhausted} db=${persistedComplete}`,
    ]);
  }
}

export function readCrawlCompleteFromEvidence(evidence: string | null | undefined): boolean | null {
  const m = evidence?.match(/\[CRAWL_COMPLETE:(true|false)\]/i);
  if (!m) return null;
  return m[1]!.toLowerCase() === "true";
}
