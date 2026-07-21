/**
 * Gate apply progressivo — risultati certificati verso live.
 * HOT: canEmitHot + doppia passata concordante, non solo marker testuali.
 */
import { canEmitHot, explainCanEmitHot, type HotEmitEvidence } from "@/lib/sanita/can-emit-hot";
import type { IdentityStatus } from "@/lib/sanita/identity-evidence";
import { deriveCrawlComplete } from "@/lib/evidence/contract";
import { readBusinessVerdict, readProcessingState, readValidationStatus } from "@/lib/sanita/processing-state";
import { isLegacyLead } from "@/lib/sanita/evidence-version";

export type CertifiedApplyRow = {
  id?: string;
  processingState?: string | null;
  newVerdict?: string | null;
  fullEvidence?: string | null;
  dualDisagreement?: boolean;
  website?: string | null;
  websiteReachable?: boolean | null;
  pagesVisited?: number | null;
  category?: string | null;
  crawlComplete?: boolean | null;
  policyExhaustive?: boolean | null;
  needsOcrReview?: boolean | null;
  error?: string | null;
  reasonCode?: string | null;
  pass1?: {
    token?: string | null;
    processingState?: string | null;
    crawlComplete?: boolean | null;
    policyFound?: boolean | null;
    error?: string | null;
    runId?: string | null;
  } | null;
  pass2?: {
    token?: string | null;
    processingState?: string | null;
    crawlComplete?: boolean | null;
    policyFound?: boolean | null;
    error?: string | null;
    runId?: string | null;
  } | null;
  runIds?: string[] | null;
  frontierPaths?: string[] | null;
  /** Se true, completeness da frontier DB (apply produzione). */
  requirePersistedCompleteness?: boolean;
};

export type ApplyGateResult = { ok: true } | { ok: false; error: string; reasons?: string[] };

const BLOCKED_STATES = /\[STATE:(RETRY_PENDING|TECHNICAL_BLOCKED|REVIEW_HUMAN|OUT_OF_SCOPE)\]/i;
const BLOCKED_REASON = /RETRY|TIMEOUT|ANALYZE_ERROR|TECHNICAL|OCR_FAIL|IDENTITY_MISMATCH/i;

function readIdentityStatus(evidence: string): IdentityStatus | "UNKNOWN" {
  const m = evidence.match(/\[IDENTITY:([A-Z_]+)\]/i);
  return m ? (m[1]!.toUpperCase() as IdentityStatus) : "UNKNOWN";
}

function readCrawlRunId(row: CertifiedApplyRow, evidence: string): string | null {
  const fromRunIds = row.runIds?.filter(Boolean);
  if (fromRunIds?.length) return fromRunIds[fromRunIds.length - 1] ?? null;
  const m = evidence.match(/\[CRAWL_RUN:([^\]]+)\]/i);
  return m ? m[1]!.trim() : row.pass2?.runId || row.pass1?.runId || null;
}

function evidenceIsCurrent(evidence: string): boolean {
  return /\[EV_V:2\b/i.test(evidence) && /LEGACY:CURRENT/i.test(evidence);
}

function dualHotPasses(row: CertifiedApplyRow): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (row.dualDisagreement) reasons.push("dualDisagreement");
  const a = row.pass1;
  const b = row.pass2;
  if (!a || !b) {
    reasons.push("dual_pass_missing");
    return { ok: false, reasons };
  }
  if (a.error || b.error) reasons.push("dual_pass_error");
  const agree =
    !a.error &&
    !b.error &&
    a.token === "HOT" &&
    b.token === "HOT" &&
    a.crawlComplete === true &&
    b.crawlComplete === true &&
    a.policyFound !== true &&
    b.policyFound !== true &&
    a.processingState === "HOT_VERIFIED" &&
    b.processingState === "HOT_VERIFIED";
  if (!agree) reasons.push("dual_pass_not_agreed");
  return { ok: agree && reasons.length === 0, reasons };
}

export function buildHotEmitEvidenceFromApplyRow(row: CertifiedApplyRow): HotEmitEvidence {
  const evidence = row.fullEvidence || "";
  const usePersisted = row.requirePersistedCompleteness === true;
  return {
    website: row.website,
    websiteReachable: row.websiteReachable,
    pagesVisited: Number(row.pagesVisited ?? 0),
    policyExhaustive: row.policyExhaustive === true || /\[CRAWL_COMPLETE:true\]/i.test(evidence),
    needsOcrReview: row.needsOcrReview === true || /\[OCR:REVIEW\]/i.test(evidence),
    identityStatus: readIdentityStatus(evidence),
    category: row.category,
    crawlRunId: usePersisted ? readCrawlRunId(row, evidence) : null,
    requirePersistedCompleteness: usePersisted,
    crawlCompleteness:
      row.crawlComplete === true || /\[CRAWL_COMPLETE:true\]/i.test(evidence)
        ? deriveCrawlComplete({
            identityVerified: true,
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
          })
        : null,
  };
}

/** Gate HOT apply — fail-closed. */
export function validateHotApply(row: CertifiedApplyRow): ApplyGateResult {
  const evidence = row.fullEvidence || "";

  if (row.processingState !== "HOT_VERIFIED") {
    return { ok: false, error: "hot_not_terminal", reasons: [`state=${row.processingState}`] };
  }
  if (row.newVerdict !== "HOT") {
    return { ok: false, error: "hot_missing_token", reasons: [`newVerdict=${row.newVerdict}`] };
  }
  if (!evidence.trim()) {
    return { ok: false, error: "missing_fullEvidence" };
  }
  if (!evidenceIsCurrent(evidence) || isLegacyLead(evidence)) {
    return { ok: false, error: "hot_evidence_not_current_version" };
  }
  if (!/^\[V:HOT\]/im.test(evidence)) {
    return { ok: false, error: "missing_hot_token" };
  }
  if (readProcessingState(evidence) !== "HOT_VERIFIED") {
    return { ok: false, error: "hot_missing_state_stamp" };
  }
  if (readBusinessVerdict(evidence) !== "HOT_VERIFIED") {
    return { ok: false, error: "hot_missing_business_verdict" };
  }
  const vs = readValidationStatus(evidence);
  if (vs && vs !== "CURRENT_VERIFIED") {
    return { ok: false, error: "hot_validation_not_current", reasons: [`vs=${vs}`] };
  }
  if (BLOCKED_STATES.test(evidence)) {
    return { ok: false, error: "hot_has_noncommercial_state" };
  }
  if (row.error || BLOCKED_REASON.test(String(row.reasonCode || ""))) {
    return { ok: false, error: "hot_unresolved_error", reasons: [String(row.error || row.reasonCode)] };
  }

  const dual = dualHotPasses(row);
  if (!dual.ok) {
    return { ok: false, error: "hot_dual_gate_failed", reasons: dual.reasons };
  }

  const hotEv = buildHotEmitEvidenceFromApplyRow(row);
  const explained = explainCanEmitHot(hotEv);
  if (!explained.ok || !canEmitHot(hotEv)) {
    return { ok: false, error: "hot_canonical_gate_failed", reasons: explained.reasons };
  }

  return { ok: true };
}

/** Gate PUBLISHED_* apply — invariato rispetto al percorso certificato. */
export function validatePublishedApply(row: CertifiedApplyRow): ApplyGateResult {
  const allowed = new Set(["PUBLISHED_CURRENT", "PUBLISHED_EXPIRED", "PUBLISHED_DATE_UNKNOWN"]);
  const evidence = row.fullEvidence || "";
  if (!allowed.has(String(row.processingState))) {
    return { ok: false, error: "not_certified_published", reasons: [String(row.processingState)] };
  }
  if (!evidence.trim()) return { ok: false, error: "missing_fullEvidence" };
  if (!evidenceIsCurrent(evidence) || isLegacyLead(evidence)) {
    return { ok: false, error: "evidence_not_current_version" };
  }
  if (!/^\[V:PUB\]/im.test(evidence)) return { ok: false, error: "missing_pub_token" };
  if (!/\[VS:CURRENT_VERIFIED\]/i.test(evidence)) {
    return { ok: false, error: "missing_current_verified" };
  }
  if (row.newVerdict === "HOT") return { ok: false, error: "hot_forbidden_on_published_apply" };
  return { ok: true };
}

export function validateCertifiedApplyRow(row: CertifiedApplyRow): ApplyGateResult {
  if (row.processingState === "HOT_VERIFIED") return validateHotApply(row);
  return validatePublishedApply(row);
}
