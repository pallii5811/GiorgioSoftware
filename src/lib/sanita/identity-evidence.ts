/**
 * Identità sito ↔ struttura — verified SOLO da prove, mai da verdetto precedente.
 */
export type IdentityStatus =
  | "OFFICIAL_CONFIRMED"
  | "GROUP_OFFICIAL_CONFIRMED"
  | "PROBABLE"
  | "AMBIGUOUS"
  | "MISMATCH"
  | "STALE_PANEL"
  | "INSUFFICIENT"
  | "INSUFFICIENT_TECHNICAL"
  | "INSUFFICIENT_EVIDENCE"
  | "NOT_CHECKED";

export interface IdentityEvidence {
  status: IdentityStatus;
  /** Derivato: true solo per OFFICIAL_CONFIRMED | GROUP_OFFICIAL_CONFIRMED. */
  verified: boolean;
  matchedLegalName: boolean;
  matchedFacilityName: boolean;
  matchedAddress: boolean;
  matchedMunicipality: boolean;
  matchedPhone: boolean;
  matchedTaxIdentifier: boolean;
  matchedOfficialRegistry: boolean;
  matchedGroupRelationship: boolean;
  sourceUrls: string[];
  reasons: string[];
  conflicts: string[];
  checkedAt: string;
}

export function deriveIdentityVerified(status: IdentityStatus): boolean {
  return status === "OFFICIAL_CONFIRMED" || status === "GROUP_OFFICIAL_CONFIRMED";
}

export function buildIdentityEvidence(
  partial: Omit<IdentityEvidence, "verified" | "checkedAt"> & { checkedAt?: string }
): IdentityEvidence {
  return {
    ...partial,
    verified: deriveIdentityVerified(partial.status),
    checkedAt: partial.checkedAt ?? new Date().toISOString(),
  };
}

/** Terminali HOT/PUB solo con identity verified. */
export function identityBlocksTerminalVerdict(id: IdentityEvidence | null | undefined): string | null {
  if (!id || id.status === "NOT_CHECKED") {
    return "Identità sito non verificata (NOT_CHECKED) — impossibile certificare HOT/PUBLISHED.";
  }
  if (id.status === "MISMATCH") {
    return `Contaminazione critica identità: ${id.conflicts.join("; ") || id.reasons.join("; ")}.`;
  }
  if (id.status === "INSUFFICIENT_TECHNICAL") {
    return `Identità non valutabile per problema tecnico: ${id.reasons.join("; ")}.`;
  }
  if (!id.verified) {
    return `Identità insufficiente (${id.status}) — serve OFFICIAL_CONFIRMED o GROUP_OFFICIAL_CONFIRMED.`;
  }
  return null;
}

export const NOT_CHECKED_IDENTITY: IdentityEvidence = buildIdentityEvidence({
  status: "NOT_CHECKED",
  matchedLegalName: false,
  matchedFacilityName: false,
  matchedAddress: false,
  matchedMunicipality: false,
  matchedPhone: false,
  matchedTaxIdentifier: false,
  matchedOfficialRegistry: false,
  matchedGroupRelationship: false,
  sourceUrls: [],
  reasons: ["Identità non ancora valutata"],
  conflicts: [],
});
