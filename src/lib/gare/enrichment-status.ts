/**
 * Enrichment / actionable status for Gare missing fields.
 */
export type GarePipelineStatus =
  | "UNIVERSE"
  | "ENRICHMENT_PENDING"
  | "ENRICHMENT_RUNNING"
  | "ENRICHMENT_COMPLETE"
  | "ENRICHMENT_BLOCKED"
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
  sourcesRemaining?: number;
}): GarePipelineStatus {
  if (input.revoked || input.annulled || input.deserted) return "NOT_ACTIONABLE";
  const max = input.maxEnrichmentAttempts ?? 3;
  const attempts = input.enrichmentAttempts ?? 0;
  const sourcesLeft = input.sourcesRemaining ?? 0;
  const missingCore =
    !input.awardDate || !input.winnerIdentified || !input.officialSource || !input.cig?.trim();
  if (missingCore) {
    if (attempts < max || sourcesLeft > 0) return "ENRICHMENT_PENDING";
    return "NOT_ACTIONABLE";
  }
  return "ACTIONABLE";
}

/** Missing date must never become GARE_LOW — only pending / not actionable. */
export function statusForMissingAwardDate(opts: {
  enrichmentAttempts: number;
  maxEnrichmentAttempts?: number;
  sourcesRemaining?: number;
}): Exclude<GarePipelineStatus, "ACTIONABLE" | "UNIVERSE"> {
  const max = opts.maxEnrichmentAttempts ?? 3;
  if (opts.enrichmentAttempts < max || (opts.sourcesRemaining ?? 0) > 0) {
    return "ENRICHMENT_PENDING";
  }
  return "NOT_ACTIONABLE";
}
