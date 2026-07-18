/**
 * Valore commerciale Sanità — deterministico, separato dal verdetto normativo.
 * LLM vietato come unica fonte del punteggio.
 */
import {
  commercialTierFromScore,
  type CommercialOpportunity,
} from "@/lib/evidence/contract";
import type { Verdict } from "@/lib/sanita/verdict";

export function scoreSanitaCommercial(input: {
  verdict: Verdict;
  policyObsolete?: boolean;
  hasPhone?: boolean;
  hasEmail?: boolean;
  hasWebsite?: boolean;
  pagesVisited?: number;
  crawlComplete?: boolean;
  companyName?: string;
}): CommercialOpportunity {
  const verifiedFacts: string[] = [];
  const inferences: string[] = [];
  const missingInformation: string[] = [];
  const reasons: string[] = [];
  let score = 0;

  if (input.verdict === "HOT" && input.crawlComplete) {
    score += 45;
    verifiedFacts.push("Assenza pubblicazione certificata dopo crawl completo");
    reasons.push("Assenza verificata Art.10 — priorità vendita RC");
  } else if (input.verdict === "HOT" && !input.crawlComplete) {
    return {
      score: 0,
      tier: "NOT_ACTIONABLE",
      reasons: ["HOT non certificabile — crawl incompleto"],
      verifiedFacts: [],
      inferences: [],
      missingInformation: ["Ricertificare crawl completo prima del contatto"],
      recommendedAction: "Non contattare — ricertificare crawl/identità",
    };
  } else if (input.verdict === "PUBLISHED" && input.policyObsolete) {
    score += 35;
    verifiedFacts.push("Polizza pubblicata ma scaduta/obsoleta");
    reasons.push("Pubblicazione scaduta — rinnovo / messa in regola");
  } else if (input.verdict === "PUBLISHED") {
    score += 15;
    verifiedFacts.push("Polizza pubblicata e trovata");
    reasons.push("In regola — opportunità rinnovo/confronto");
  } else {
    score += 5;
    missingInformation.push("Verdetto REVIEW — serve verifica umana");
  }

  if (input.hasPhone) {
    score += 10;
    verifiedFacts.push("Telefono presente");
  } else missingInformation.push("Telefono assente");

  if (input.hasEmail) {
    score += 8;
    verifiedFacts.push("Email/PEC presente");
  } else missingInformation.push("Email assente");

  if (input.hasWebsite) {
    score += 5;
    verifiedFacts.push("Sito web in anagrafica");
  } else missingInformation.push("Sito assente");

  if ((input.pagesVisited ?? 0) >= 12) {
    score += 5;
    verifiedFacts.push(`Crawl profondità ${input.pagesVisited} pagine`);
  }

  if (input.verdict === "HOT") {
    inferences.push("Possibile irregolarità Art.10 — da validare commercialmente con agente");
  }

  score = Math.max(0, Math.min(100, score));
  const tier = commercialTierFromScore(score);

  let recommendedAction = "Verifica manuale prima del contatto";
  if (tier === "VERY_HIGH" || tier === "HIGH") {
    recommendedAction =
      input.verdict === "HOT"
        ? "Chiamare subito — proporre RC / messa in regola Art.10"
        : "Contattare per rinnovo / aggiornamento pubblicazione";
  }
  if (tier === "NOT_ACTIONABLE") {
    recommendedAction = "Non contattare — ricertificare crawl/identità";
  }

  return {
    score,
    tier,
    reasons,
    verifiedFacts,
    inferences,
    missingInformation,
    recommendedAction,
    urgencyReason:
      input.verdict === "HOT" && input.crawlComplete
        ? "Assenza certificata — finestra commerciale aperta"
        : undefined,
  };
}
