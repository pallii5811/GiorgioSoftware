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

export const GARE_RELEVANCE_META: Record<
  GareRelevance,
  { label: string; subtitle: string; tone: string }
> = {
  HIGH: {
    label: "Priorità assicurazioni",
    subtitle: "RC, polizze, sanità o coperture dirette",
    tone: "emerald",
  },
  MEDIUM: {
    label: "Cauzione / appalto rilevante",
    subtitle: "Appalto significativo — opportunità cauzione e RC impresa",
    tone: "amber",
  },
  LOW: {
    label: "Bassa priorità",
    subtitle: "Rumore (utilities, pulizie generiche, ecc.)",
    tone: "slate",
  },
};
