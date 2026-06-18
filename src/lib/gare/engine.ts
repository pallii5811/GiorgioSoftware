import { prisma } from "@/lib/prisma";
import { fetchAnacAwards, type AnacAward } from "@/lib/gare/anac";
import { enrichTenderBatch } from "@/lib/gare/enrich";
import { relevanceCategory } from "@/lib/gare/display";
import {
  computeGareLeadScore,
  isGareCommerciallyRelevant,
  scoreGareRelevance,
} from "@/lib/gare/relevance";

export type GareScanOptions = {
  region: string;
  max?: number | "all";
  /** Se true (default), non importa gare classificate LOW. */
  commercialOnly?: boolean;
  /** Se true, ri-arricchisce contatti anche su gare già elaborate. */
  reEnrich?: boolean;
};

export type GareScanResult = {
  success: true;
  message: string;
  stats: {
    found: number;
    inserted: number;
    updated: number;
    skipped: number;
    skippedLow: number;
    year: number | null;
    years: number[];
    scanned: number;
    contacts: { enriched: number; withPhone: number; withEmail: number };
  };
  data: unknown[];
};

function isValidCig(cig: unknown): cig is string {
  return typeof cig === "string" && /^[A-Z0-9]{8,12}$/i.test(cig.trim());
}

function isValidWinner(name: unknown): name is string {
  if (typeof name !== "string") return false;
  const n = name.trim();
  if (n.length < 3) return false;
  return !/non\s+specificat|sconosciut|n\/?d|da\s+definire/i.test(n);
}

export function resolveGareMax(max?: number | "all"): number {
  if (max === "all") return 0;
  if (typeof max === "number" && max > 0) return max;
  return 200;
}

function relevanceRank(r: ReturnType<typeof scoreGareRelevance>): number {
  if (r === "HIGH") return 0;
  if (r === "MEDIUM") return 1;
  return 2;
}

function sortAwardsForBroker(awards: AnacAward[]): AnacAward[] {
  return [...awards].sort((a, b) => {
    const ra = relevanceRank(scoreGareRelevance(a.object, a.companyName, a.amount));
    const rb = relevanceRank(scoreGareRelevance(b.object, b.companyName, b.amount));
    if (ra !== rb) return ra - rb;
    if (b.amount !== a.amount) return b.amount - a.amount;
    const da = a.awardDate?.getTime() ?? 0;
    const db = b.awardDate?.getTime() ?? 0;
    return db - da;
  });
}

export async function runGareScan(opts: GareScanOptions): Promise<GareScanResult> {
  const { region, commercialOnly = true, reEnrich = false } = opts;
  const max = resolveGareMax(opts.max);

  const fetchCap = max > 0 ? Math.min(max * 4, 1200) : 0;
  const { awards: rawAwards, year, years, scanned } = await fetchAnacAwards(region, {
    max: fetchCap,
  });
  const awards = sortAwardsForBroker(rawAwards).slice(0, max > 0 ? max : undefined);

  if (year === null) {
    return {
      success: true,
      message:
        "Dataset ANAC non raggiungibile in questo momento (possibile blocco di rete/proxy). Riprova più tardi.",
      stats: {
        found: 0,
        inserted: 0,
        updated: 0,
        skipped: 0,
        skippedLow: 0,
        year: null,
        years: [],
        scanned: 0,
        contacts: { enriched: 0, withPhone: 0, withEmail: 0 },
      },
      data: [],
    };
  }

  const saved: unknown[] = [];
  const toEnrich: Parameters<typeof enrichTenderBatch>[0] = [];
  let skipped = 0;
  let skippedLow = 0;
  let inserted = 0;
  let updated = 0;

  for (const a of awards) {
    if (!isValidCig(a.cig) || !isValidWinner(a.companyName) || !(a.amount > 0)) {
      skipped++;
      continue;
    }

    const relevance = scoreGareRelevance(a.object, a.companyName, a.amount);
    if (commercialOnly && !isGareCommerciallyRelevant(a.object, a.companyName, a.amount)) {
      skippedLow++;
      continue;
    }

    const cig = a.cig.trim().toUpperCase();
    const category = relevanceCategory(relevance);
    const leadScore = computeGareLeadScore(relevance, a.amount, false, false);

    const existing = await prisma.lead.findUnique({ where: { tenderCig: cig }, select: { id: true } });
    const lead = await prisma.lead.upsert({
      where: { tenderCig: cig },
      update: {
        companyName: a.companyName.trim(),
        region,
        tenderAmount: a.amount,
        tenderObject: a.object || "Appalto pubblico",
        tenderWinner: a.companyName.trim(),
        category,
        leadScore,
        city: a.buyerCity,
      },
      create: {
        type: "TENDER",
        companyName: a.companyName.trim(),
        region,
        tenderCig: cig,
        tenderAmount: a.amount,
        tenderObject: a.object || "Appalto pubblico",
        tenderWinner: a.companyName.trim(),
        category,
        leadScore,
        city: a.buyerCity,
        status: "NEW",
      },
    });

    if (existing) updated++;
    else inserted++;

    saved.push(lead);

    const needsEnrich = reEnrich || !lead.lastScannedAt;
    if (needsEnrich) {
      toEnrich.push({
        id: lead.id,
        companyName: lead.companyName,
        region,
        meta: {
          datasetYear: a.datasetYear,
          cig,
          object: a.object || "Appalto pubblico",
          buyer: a.buyer,
          buyerCity: a.buyerCity,
          amount: a.amount,
          awardDate: a.awardDate,
          relevance,
        },
      });
    }
  }

  let contactStats = { enriched: 0, withPhone: 0, withEmail: 0 };
  if (toEnrich.length > 0) {
    contactStats = await enrichTenderBatch(toEnrich, 6);
  }

  const yearLabel = years.length > 1 ? `${years.join("+")}` : String(year);
  const message =
    `ANAC ${yearLabel} · ${region}: ${awards.length} aggiudicazioni analizzate, ` +
    `${inserted} nuove, ${updated} aggiornate` +
    (skippedLow > 0 ? `, ${skippedLow} escluse (bassa priorità)` : "") +
    (skipped > 0 ? `, ${skipped} scartate` : "") +
    ` · contatti: ${contactStats.withPhone} tel, ${contactStats.withEmail} email.`;

  return {
    success: true,
    message,
    stats: {
      found: awards.length,
      inserted,
      updated,
      skipped,
      skippedLow,
      year,
      years,
      scanned,
      contacts: contactStats,
    },
    data: saved,
  };
}
