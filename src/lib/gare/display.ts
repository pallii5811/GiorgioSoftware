import type { GareRelevance } from "@/lib/gare/relevance";

const CATEGORY_MAP: Record<string, GareRelevance> = {
  GARE_HIGH: "HIGH",
  GARE_MEDIUM: "MEDIUM",
  GARE_LOW: "LOW",
};

export function categoryToRelevance(category: string | null | undefined): GareRelevance | null {
  if (!category) return null;
  return CATEGORY_MAP[category.toUpperCase()] ?? null;
}

export function relevanceCategory(relevance: GareRelevance): string {
  return `GARE_${relevance}`;
}

export function parseTenderDatasetYear(evidence: string | null | undefined): number | null {
  const m = evidence?.match(/ANAC\s+(\d{4})/i);
  return m ? Number(m[1]) : null;
}

export function parseTenderAwardDate(evidence: string | null | undefined): string | null {
  const m = evidence?.match(/Data\s+aggiudicazione:\s*(\d{4}-\d{2}-\d{2})/i);
  return m?.[1] ?? null;
}

export function parseTenderBuyer(evidence: string | null | undefined): string | null {
  const m = evidence?.match(/Stazione\s+appaltante:\s*([^·]+)/i);
  return m?.[1]?.trim() ?? null;
}

export function parseTenderOpportunity(evidence: string | null | undefined): string | null {
  const m = evidence?.match(/Opportunità:\s*([^·]+)/i);
  return m?.[1]?.trim() ?? null;
}

export function parseTenderBuyerCity(evidence: string | null | undefined): string | null {
  const m = evidence?.match(/Comune\s+stazione:\s*([^·]+)/i);
  return m?.[1]?.trim() ?? null;
}

/** Esclude gare aggiudicate prima del 2024 (irrilevanti per cauzione/RC). */
export function isFreshTenderLead(evidence: string | null | undefined): boolean {
  return !isStaleTenderAward(evidence);
}

export const GARE_RELEVANCE_META: Record<
  GareRelevance,
  { label: string; subtitle: string; tone: string; opportunity: string }
> = {
  HIGH: {
    label: "Priorità assicurazioni",
    subtitle: "RC, polizze, sanità o coperture dirette",
    opportunity: "RC / polizze / sanità",
    tone: "emerald",
  },
  MEDIUM: {
    label: "Cauzione / appalto rilevante",
    subtitle: "Appalto significativo — opportunità cauzione e RC impresa",
    opportunity: "Cauzione definitiva + RC impresa",
    tone: "amber",
  },
  LOW: {
    label: "Bassa priorità",
    subtitle: "Rumore (utilities, pulizie generiche, ecc.)",
    opportunity: "Bassa priorità broker",
    tone: "slate",
  },
};

/** Gare aggiudicate prima di questa data non sono mostrate (troppo vecchie per cauzione/RC). */
export const GARE_MIN_AWARD_DATE = new Date("2024-01-01T00:00:00Z");

export function parseTenderAwardDateObj(evidence: string | null | undefined): Date | null {
  const iso = parseTenderAwardDate(evidence);
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isStaleTenderAward(evidence: string | null | undefined): boolean {
  const d = parseTenderAwardDateObj(evidence);
  if (!d) return false;
  return d < GARE_MIN_AWARD_DATE;
}

export function awardMonthsAgo(evidence: string | null | undefined): number | null {
  const d = parseTenderAwardDateObj(evidence);
  if (!d) return null;
  const months = Math.floor((Date.now() - d.getTime()) / (30.44 * 24 * 3600_000));
  return months >= 0 ? months : null;
}
