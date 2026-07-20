/**
 * Filtro coda commerciale — backend gate.
 * Default sicuro: ACTIONABLE_QUEUE_REQUIRE_CURRENT_EVIDENCE=true
 */
import { isActionableEvidence, isLegacyLead } from "@/lib/sanita/evidence-version";
import { readVerdictToken } from "@/lib/sanita/verdict";
import { parseEvidenceJson } from "@/lib/evidence/contract";

export function requireCurrentEvidence(): boolean {
  const raw = process.env.ACTIONABLE_QUEUE_REQUIRE_CURRENT_EVIDENCE;
  if (raw === "0" || raw === "false") return false;
  return true; // default sicuro
}

export type ActionableLeadLike = {
  type?: string | null;
  evidence?: string | null;
  category?: string | null;
  leadScore?: number | null;
  lastScannedAt?: Date | string | null;
};

/**
 * Coda commerciale certificata: solo evidence corrente, no REVIEW, no legacy.
 */
export function isInActionableSalesQueue(lead: ActionableLeadLike): boolean {
  if (!requireCurrentEvidence()) {
    const v = readVerdictToken(lead.evidence);
    if (v === "REVIEW") return false;
    return true;
  }

  // RETRY_PENDING / TECHNICAL_BLOCKED / REVIEW_HUMAN / OUT_OF_SCOPE fuori coda commerciale
  if (/\[STATE:(RETRY_PENDING|TECHNICAL_BLOCKED|CRAWL_RUNNING|DISCOVERED|REVIEW_HUMAN|OUT_OF_SCOPE)\]/i.test(lead.evidence || "")) {
    return false;
  }
  if (/\[BV:REVIEW_HUMAN\]|\[BV:OUT_OF_SCOPE\]|\[BV:NONE\]/i.test(lead.evidence || "")) {
    return false;
  }
  if (/\[ENRICH:(ENRICHMENT_PENDING|ENRICHMENT_RUNNING|ENRICHMENT_BLOCKED|NOT_ACTIONABLE)\]/i.test(lead.evidence || "")) {
    return false;
  }
  if (/\[VS:(REVALIDATION_PENDING|TECHNICAL_BLOCKED)\]/i.test(lead.evidence || "")) {
    // Legacy PUB con revalidation pending resta in coda solo se business PUB urgente (expired)
    const urgent = /\[BV:PUBLISHED_EXPIRED\]/i.test(lead.evidence || "");
    if (!urgent) return false;
  }

  if (isLegacyLead(lead.evidence)) return false;
  if (!isActionableEvidence(lead.evidence)) return false;

  const v = readVerdictToken(lead.evidence);
  if (v === "REVIEW") return false;
  if (v !== "HOT" && v !== "PUBLISHED" && lead.type !== "TENDER") return false;

  const payload = parseEvidenceJson<{ commercialTier?: string }>(lead.evidence);
  if (payload?.commercialTier === "NOT_ACTIONABLE" || payload?.commercialTier === "LOW") {
    return false;
  }

  if (lead.type === "TENDER") {
    const cat = (lead.category || "").toUpperCase();
    if (!cat || cat === "NON_CLASSIFICATO" || cat === "GARE_LOW" || /undefined/i.test(cat)) {
      return false;
    }
    // Vista principale: solo rilevanza HIGH (MEDIUM via filtro esplicito non-priority)
    if (cat !== "GARE_HIGH" && cat !== "GARE_MEDIUM") return false;
  }

  return true;
}

/**
 * Vista cliente default: nasconde HOT/PUB legacy e REVIEW;
 * lascia i pending (non scansionati) per la pipeline operativa.
 */
export function passesDefaultClientQueueGate(lead: ActionableLeadLike): boolean {
  if (!requireCurrentEvidence()) return true;
  const v = readVerdictToken(lead.evidence);
  if (!v) return true; // unscanned / no verdict token
  if (v === "REVIEW") return false;
  if (v === "HOT" || v === "PUBLISHED") {
    return isInActionableSalesQueue(lead);
  }
  if (lead.type === "TENDER") return isInActionableSalesQueue(lead);
  return false;
}

/** Alias testabile: legacy HOT non entra in coda. */
export function legacyHotExcludedFromQueue(evidence: string | null): boolean {
  const v = readVerdictToken(evidence);
  if (v !== "HOT") return false;
  return isLegacyLead(evidence) || !isActionableEvidence(evidence);
}
