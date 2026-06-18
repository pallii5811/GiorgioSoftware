import type { LeadIdentityFields } from "@/lib/sanita/lead-dedup";
import { pickCanonicalLead } from "@/lib/sanita/lead-dedup";

function evidenceQualityScore(evidence: string | null | undefined): number {
  if (!evidence) return 0;
  if (/\[V:PUB\].*costi[\-_]?contabilizzat|autoassicuraz/i.test(evidence)) return 0;
  if (evidence.includes("[V:PUB]")) return 3;
  if (evidence.includes("[V:HOT]")) return 2;
  if (evidence.includes("[V:REV")) return 1;
  return 0;
}

/** Sceglie quale scheda ha l'analisi migliore da preservare sul canonical. */
export function pickBestScannedLead<T extends LeadIdentityFields>(group: T[]): T | null {
  const scanned = group.filter((l) => l.lastScannedAt);
  if (!scanned.length) return null;
  return pickCanonicalLead(scanned);
}

/** True se l'analisi del donor è migliore di quella già sul keeper. */
export function shouldMergeScanIntoKeeper(
  keeper: LeadIdentityFields,
  donor: LeadIdentityFields
): boolean {
  if (!donor.lastScannedAt) return false;
  if (!keeper.lastScannedAt) return true;

  const dEv = evidenceQualityScore(donor.evidence);
  const kEv = evidenceQualityScore(keeper.evidence);
  if (dEv !== kEv) return dEv > kEv;

  const dPages = donor.pagesVisited ?? 0;
  const kPages = keeper.pagesVisited ?? 0;
  if (dPages !== kPages) return dPages > kPages;

  const dTime = donor.lastScannedAt.getTime();
  const kTime = keeper.lastScannedAt.getTime();
  return dTime > kTime;
}

export type ScanMergePayload = {
  lastScannedAt: Date;
  policyFound: boolean | null;
  policyCompany: string | null;
  policyMassimale: string | null;
  policyNumber: string | null;
  policyExpiry: Date | null;
  confidence: number | null;
  evidence: string | null;
  websiteReachable: boolean | null;
  pagesVisited: number | null;
  leadScore: number | null;
  phone: string | null;
  email: string | null;
  pec: string | null;
  website: string | null;
};

/** Campi da copiare sul canonical prima di eliminare un duplicato scansionato. */
export function buildScanMergePayload(
  keeper: LeadIdentityFields,
  donor: ScanMergePayload
): ScanMergePayload {
  return {
    lastScannedAt: donor.lastScannedAt,
    policyFound: donor.policyFound,
    policyCompany: donor.policyCompany,
    policyMassimale: donor.policyMassimale,
    policyNumber: donor.policyNumber,
    policyExpiry: donor.policyExpiry,
    confidence: donor.confidence,
    evidence: donor.evidence,
    websiteReachable: donor.websiteReachable,
    pagesVisited: donor.pagesVisited,
    leadScore: donor.leadScore,
    phone: keeper.phone || donor.phone,
    email: keeper.email || donor.email,
    pec: keeper.pec || donor.pec,
    website: keeper.website || donor.website,
  };
}
