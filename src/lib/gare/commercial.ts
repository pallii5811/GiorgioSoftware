/**
 * Valore commerciale Gare — score 0–100 spiegabile.
 * Cauzione: MAI mostrata come fatto se non documentata → ESTIMATE.
 */
import {
  commercialTierFromScore,
  type ClaimKind,
  type CommercialOpportunity,
  type FieldClaim,
} from "@/lib/evidence/contract";
import { gareRecencyBucket } from "@/lib/gare/source-registry";

/** Stima cauzione definitiva tipica 10% — NON è un fatto documentale. */
export const CAUZIONE_ESTIMATE_RATE = 0.1;

export function estimateCauzione(amount: number): FieldClaim<number> {
  const value = Math.round((amount || 0) * CAUZIONE_ESTIMATE_RATE);
  return {
    value,
    kind: "ESTIMATE",
    confidence: 0.4,
    extractionMethod: "heuristic_10pct_garanzia_definitiva",
    needsHumanReview: true,
  };
}

export function scoreGareCommercial(input: {
  awardDate: Date | null;
  amount: number;
  hasPhone: boolean;
  hasEmail: boolean;
  hasWebsite: boolean;
  relevance: "HIGH" | "MEDIUM" | "LOW";
  winnerIdentified: boolean;
  officialSource: boolean;
}): CommercialOpportunity {
  const verifiedFacts: string[] = [];
  const inferences: string[] = [];
  const missingInformation: string[] = [];
  const reasons: string[] = [];
  let score = 0;

  if (!input.officialSource || !input.winnerIdentified) {
    return {
      score: 0,
      tier: "NOT_ACTIONABLE",
      reasons: ["Fonte ufficiale o vincitore non verificati"],
      verifiedFacts,
      inferences,
      missingInformation: ["Identità/fonte insufficienti"],
      recommendedAction: "Non mostrare in coda commerciale",
    };
  }

  const bucket = gareRecencyBucket(input.awardDate);
  const recencyPts =
    bucket === "0_30" ? 20 : bucket === "31_90" ? 16 : bucket === "91_180" ? 10 : bucket === "181_365" ? 5 : 0;
  score += recencyPts;
  if (recencyPts > 0) verifiedFacts.push(`Recency bucket ${bucket} (+${recencyPts})`);
  else missingInformation.push("Aggiudicazione troppo vecchia o data assente");

  // Fase utile (proxy da recency)
  const phasePts = bucket === "0_30" || bucket === "31_90" ? 15 : bucket === "91_180" ? 8 : 0;
  score += phasePts;

  // Importo
  let amountPts = 0;
  if (input.amount >= 1_000_000) amountPts = 20;
  else if (input.amount >= 250_000) amountPts = 14;
  else if (input.amount >= 75_000) amountPts = 8;
  else if (input.amount > 0) amountPts = 3;
  score += amountPts;
  if (input.amount > 0) verifiedFacts.push(`Importo €${Math.round(input.amount)}`);

  // Compatibilità assicurativa
  const insPts = input.relevance === "HIGH" ? 20 : input.relevance === "MEDIUM" ? 12 : 0;
  score += insPts;
  if (insPts) reasons.push(`Rilevanza broker ${input.relevance}`);

  // Certezza vincitore
  score += 10;
  verifiedFacts.push("Vincitore identificato su fonte ufficiale");

  // Contattabilità
  let contactPts = 0;
  if (input.hasPhone) contactPts += 5;
  if (input.hasEmail) contactPts += 3;
  if (input.hasWebsite) contactPts += 2;
  score += contactPts;
  if (!input.hasPhone) missingInformation.push("Telefono assente");

  // Qualità prove
  score += input.officialSource ? 5 : 0;

  inferences.push(
    "Cauzione definitiva tipicamente richiesta in fase di stipula — importo stimato al 10% se non documentato"
  );

  score = Math.max(0, Math.min(100, score));
  const tier = commercialTierFromScore(score);

  return {
    score,
    tier,
    reasons,
    verifiedFacts,
    inferences,
    missingInformation,
    recommendedAction:
      tier === "VERY_HIGH" || tier === "HIGH"
        ? "Contattare l'aggiudicatario — verificare cauzione/RC richieste dal contratto"
        : tier === "NOT_ACTIONABLE"
          ? "Archivio / non mostrare in coda principale"
          : "Valutare solo se contattabile e contratto ancora attivo",
    urgencyReason: bucket === "0_30" ? "Aggiudicazione ≤30 giorni" : undefined,
  };
}

export function claimKindLabel(kind: ClaimKind): string {
  if (kind === "FACT") return "Verificato";
  if (kind === "ESTIMATE") return "Stima (non documentata)";
  if (kind === "INFERENCE") return "Inferenza";
  return "Dato mancante";
}
