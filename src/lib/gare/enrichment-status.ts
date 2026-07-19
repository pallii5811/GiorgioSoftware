/**
 * Enrichment / actionable status for Gare missing fields.
 */
export type GarePipelineStatus =
  | "UNIVERSE"
  | "ENRICHMENT_PENDING"
  | "ACTIONABLE"
  | "NOT_ACTIONABLE";

export function classifyGarePipelineStatus(input: {
  awardDate: Date | string | null | undefined;
  winnerIdentified: boolean;
  officialSource: boolean;
  cig?: string | null;
  revoked?: boolean;
  annulled?: boolean;
  deserted?: boolean;
  enrichmentAttempts?: number;
  maxEnrichmentAttempts?: number;
}): GarePipelineStatus {
  if (input.revoked || input.annulled || input.deserted) return "NOT_ACTIONABLE";
  const max = input.maxEnrichmentAttempts ?? 3;
  const attempts = input.enrichmentAttempts ?? 0;
  const missingCore =
    !input.awardDate || !input.winnerIdentified || !input.officialSource || !input.cig?.trim();
  if (missingCore) {
    if (attempts < max) return "ENRICHMENT_PENDING";
    return "NOT_ACTIONABLE";
  }
  return "ACTIONABLE";
}
