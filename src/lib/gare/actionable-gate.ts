/**
 * Gate coda commerciale Gare.
 * NON_CLASSIFICATO / missing → escluso (mai inventare GARE_LOW).
 */
import { scoreGareCommercial } from "@/lib/gare/commercial";
import {
  isNonClassifiedGareCategory,
  relevanceCategory,
} from "@/lib/gare/display";
import type { GareRelevance } from "@/lib/gare/relevance";

export type GareActionableInput = {
  awardDate: Date | null;
  amount: number;
  hasPhone: boolean;
  hasEmail: boolean;
  hasWebsite: boolean;
  relevance: GareRelevance | null | undefined;
  winnerIdentified: boolean;
  officialSource: boolean;
  revoked?: boolean;
  annulled?: boolean;
  deserted?: boolean;
  provisional?: boolean;
  cig?: string | null;
  lotId?: string | null;
  /** Categoria contratto o legacy GARE_* */
  category?: string | null;
  /** DOCUMENTED | STRONGLY_INFERRED required for HIGH/VH */
  insuranceNeed?: "DOCUMENTED" | "STRONGLY_INFERRED" | "WEAKLY_INFERRED" | "NOT_FOUND" | null;
  contactPath?: boolean;
};

export type GareActionableResult = {
  actionable: boolean;
  category: string;
  score: number;
  tier: string;
  exclusions: string[];
};

export function evaluateGareActionable(input: GareActionableInput): GareActionableResult {
  const exclusions: string[] = [];
  const category = input.category?.trim()
    ? input.category.trim()
    : relevanceCategory(input.relevance);

  if (/undefined/i.test(category) || category === "GARE_") {
    exclusions.push("GARE_undefined vietato");
  }
  if (category.toUpperCase() === "GARE_LOW") {
    exclusions.push("GARE_LOW non è categoria valida");
  }
  if (isNonClassifiedGareCategory(category)) {
    exclusions.push("NON_CLASSIFICATO escluso dalla Actionable Sales Queue");
  }
  if (input.revoked) exclusions.push("procedura revocata");
  if (input.annulled) exclusions.push("procedura annullata");
  if (input.deserted) exclusions.push("gara deserta");
  if (input.provisional) exclusions.push("graduatoria/proposta non definitiva");
  if (!input.awardDate) exclusions.push("data aggiudicazione mancante");
  if (!input.winnerIdentified) exclusions.push("vincitore non verificato");
  if (!input.officialSource) exclusions.push("fonte ufficiale assente");
  if (!input.cig?.trim()) exclusions.push("CIG assente");

  const contactOk =
    input.hasPhone || input.hasEmail || input.hasWebsite || input.contactPath === true;
  if (!contactOk) exclusions.push("contatto o percorso concreto assente");

  const ins = input.insuranceNeed;
  if (
    ins != null &&
    ins !== "DOCUMENTED" &&
    ins !== "STRONGLY_INFERRED"
  ) {
    exclusions.push("bisogno assicurativo non DOCUMENTED/STRONGLY_INFERRED");
  }

  const scoredRelevance: GareRelevance | null =
    input.relevance === "HIGH" || input.relevance === "MEDIUM" || input.relevance === "LOW"
      ? input.relevance
      : null;

  // Senza rilevanza nota: non inventare LOW — score commerciale neutro/escluso
  const commercial = scoredRelevance
    ? scoreGareCommercial({
        awardDate: input.awardDate,
        amount: input.amount,
        hasPhone: input.hasPhone,
        hasEmail: input.hasEmail,
        hasWebsite: input.hasWebsite,
        relevance: scoredRelevance,
        winnerIdentified: input.winnerIdentified,
        officialSource: input.officialSource,
      })
    : {
        score: 0,
        tier: "NOT_ACTIONABLE" as const,
        reasons: ["Rilevanza broker assente — NON_CLASSIFICATO"],
        verifiedFacts: [] as string[],
        inferences: [] as string[],
        missingInformation: ["relevance"],
        recommendedAction: "Non mostrare in coda",
      };

  if (commercial.tier === "LOW" || commercial.tier === "NOT_ACTIONABLE") {
    exclusions.push(`tier ${commercial.tier} escluso dalla vista principale`);
  }

  if (
    (commercial.tier === "HIGH" || commercial.tier === "VERY_HIGH") &&
    !input.awardDate
  ) {
    exclusions.push("HIGH senza data — non actionable");
  }
  if (
    (commercial.tier === "HIGH" || commercial.tier === "VERY_HIGH") &&
    ins != null &&
    ins !== "DOCUMENTED" &&
    ins !== "STRONGLY_INFERRED"
  ) {
    exclusions.push("HIGH/VH senza valore assicurativo concreto");
  }
  // Default fail-closed for HIGH/VH when insurance not assessed
  if ((commercial.tier === "HIGH" || commercial.tier === "VERY_HIGH") && ins == null) {
    exclusions.push("HIGH/VH richiede assessment bisogno assicurativo");
  }
  if ((commercial.tier === "HIGH" || commercial.tier === "VERY_HIGH") && !contactOk) {
    exclusions.push("HIGH/VH senza contatto");
  }

  const actionable =
    exclusions.length === 0 &&
    (commercial.tier === "VERY_HIGH" || commercial.tier === "HIGH" || commercial.tier === "MEDIUM");

  return {
    actionable,
    category,
    score: commercial.score,
    tier: commercial.tier,
    exclusions,
  };
}
