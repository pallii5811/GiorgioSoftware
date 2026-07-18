import { gunzipSync } from "node:zlib";
import { externalFetch } from "@/lib/http";

/**
 * Client per i dati ANAC (appalti pubblici italiani) in formato OCDS.
 *
 * Fonte: mirror ufficiale dell'Open Contracting Partnership, che pubblica i
 * dataset BDNCP di ANAC come JSONL compresso (gzip). A differenza del portale
 * dati.anticorruzione.it (protetto da WAF), questo endpoint è accessibile via API.
 * Ogni riga del file è un "contracting process" in standard OCDS.
 */

const DATASET_URL = (year: number) =>
  `https://data.open-contracting.org/en/publication/117/download?name=${year}.jsonl.gz`;

export interface AnacAward {
  cig: string;
  companyName: string;
  amount: number;
  object: string;
  buyer: string | null;
  buyerCity: string | null;
  buyerCap: string | null;
  awardDate: Date | null;
  datasetYear: number;
}

const CAP_REGION: Record<string, string[]> = {
  Veneto: ["30", "31", "32", "35", "36", "37", "45"],
  Campania: ["80", "81", "82", "83", "84"],
};

function regionFromCap(cap: string): string | null {
  if (!/^\d{5}$/.test(cap)) return null;
  const p = cap.slice(0, 2);
  for (const [region, prefixes] of Object.entries(CAP_REGION)) {
    if (prefixes.includes(p)) return region;
  }
  return null;
}

interface OcdsAward {
  status?: string;
  date?: string;
  contractPeriod?: { startDate?: string; endDate?: string };
  relatedLots?: string[];
  items?: { id?: string; description?: string }[];
  suppliers?: { name?: string }[];
  value?: { amount?: number };
}

interface OcdsParty {
  roles?: string[];
  name?: string;
  address?: { postalCode?: string; locality?: string };
}

interface OcdsRelease {
  awards?: OcdsAward[];
  parties?: OcdsParty[];
  tender?: { description?: string };
  buyer?: { name?: string };
  date?: string;
}

interface OcdsLine {
  compiledRelease?: OcdsRelease;
  releases?: OcdsRelease[];
}

function parseOcdsDate(raw?: string | null): Date | null {
  if (!raw || typeof raw !== "string") return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pickAwardDate(award: OcdsAward, release: OcdsRelease): Date | null {
  return (
    parseOcdsDate(award.date) ??
    parseOcdsDate(award.contractPeriod?.startDate) ??
    parseOcdsDate(release.date) ??
    null
  );
}

function pickCig(award: OcdsAward): string | null {
  const candidates: unknown[] = [];
  if (Array.isArray(award?.relatedLots)) candidates.push(...award.relatedLots);
  if (Array.isArray(award?.items)) for (const it of award.items) candidates.push(it?.id);
  for (const c of candidates) {
    if (typeof c === "string") {
      const v = c.trim().toUpperCase();
      if (/^[A-Z0-9]{10}$/.test(v)) return v;
    }
  }
  return null;
}

function bestAward(
  awards: OcdsAward[],
  release: OcdsRelease
): {
  supplier: string;
  amount: number;
  cig: string;
  object: string;
  awardDate: Date | null;
} | null {
  let best: {
    supplier: string;
    amount: number;
    cig: string;
    object: string;
    awardDate: Date | null;
  } | null = null;

  for (const a of awards) {
    if (!a || (a.status && a.status !== "active")) continue;
    const supplier = a.suppliers?.[0]?.name;
    const amount = Number(a.value?.amount);
    if (typeof supplier !== "string" || supplier.trim().length < 3) continue;
    if (!(amount > 0)) continue;
    const cig = pickCig(a);
    if (!cig) continue;
    const object = a.items?.[0]?.description || "";
    const awardDate = pickAwardDate(a, release);
    if (!best || amount > best.amount) {
      best = { supplier: supplier.trim(), amount, cig, object, awardDate };
    }
  }
  return best;
}

async function downloadDataset(year: number): Promise<string | null> {
  try {
    const res = await externalFetch(DATASET_URL(year), { timeoutMs: 90_000, redirect: "follow" });
    if (!res.ok) return null;
    const gz = Buffer.from(await res.arrayBuffer());
    if (gz.length === 0) return null;
    return gunzipSync(gz).toString("utf-8");
  } catch {
    return null;
  }
}

function mergeAward(into: Map<string, AnacAward>, next: AnacAward): void {
  const prev = into.get(next.cig);
  if (!prev) {
    into.set(next.cig, next);
    return;
  }
  const prevTs = prev.awardDate?.getTime() ?? 0;
  const nextTs = next.awardDate?.getTime() ?? 0;
  if (nextTs > prevTs || (nextTs === prevTs && next.amount > prev.amount)) {
    into.set(next.cig, next);
  }
}

async function collectYearAwards(
  region: string,
  year: number,
  awardCap?: number
): Promise<{ awards: AnacAward[]; scanned: number }> {
  const jsonl = await downloadDataset(year);
  if (!jsonl) return { awards: [], scanned: 0 };

  const out: AnacAward[] = [];
  let scanned = 0;

  for (const line of jsonl.split("\n")) {
    if (awardCap && out.length >= awardCap) break;
    if (!line) continue;

    let obj: OcdsLine & OcdsRelease;
    try {
      obj = JSON.parse(line) as OcdsLine & OcdsRelease;
    } catch {
      continue;
    }

    const release: OcdsRelease = obj.compiledRelease ?? obj.releases?.[0] ?? obj;
    const awardsArr = Array.isArray(release.awards) ? release.awards : [];
    if (awardsArr.length === 0) continue;

    const buyerParty =
      release.parties?.find((p) => p.roles?.includes("buyer")) ?? release.parties?.[0];
    const cap =
      typeof buyerParty?.address?.postalCode === "string" ? buyerParty.address.postalCode.trim() : "";
    if (regionFromCap(cap) !== region) continue;
    scanned++;

    const winner = bestAward(awardsArr, release);
    if (!winner) continue;

    const object = (winner.object || release?.tender?.description || "Appalto pubblico").trim();
    const buyer = buyerParty?.name ?? release?.buyer?.name ?? null;
    const buyerCity =
      typeof buyerParty?.address?.locality === "string" ? buyerParty.address.locality.trim() : null;

    out.push({
      cig: winner.cig,
      companyName: winner.supplier,
      amount: winner.amount,
      object: String(object).slice(0, 300),
      buyer: buyer ? String(buyer).slice(0, 200) : null,
      buyerCity: buyerCity ? String(buyerCity).slice(0, 120) : null,
      buyerCap: cap || null,
      awardDate: winner.awardDate,
      datasetYear: year,
    });
  }

  return { awards: out, scanned };
}

/**
 * Scarica aggiudicazioni ANAC per regione (anni corrente + precedente).
 * Deduplica per CIG tenendo il record più recente.
 */
export async function fetchAnacAwards(
  region: string,
  opts: { max?: number } = {}
): Promise<{ awards: AnacAward[]; year: number | null; years: number[]; scanned: number }> {
  const max = opts.max ?? 60;
  const unlimited = max <= 0;
  const now = new Date().getFullYear();
  const yearsTried: number[] = [];
  const merged = new Map<string, AnacAward>();
  let totalScanned = 0;

  for (const year of [now, now - 1]) {
    const { awards, scanned } = await collectYearAwards(region, year, unlimited ? undefined : max);
    if (scanned === 0 && awards.length === 0) continue;
    yearsTried.push(year);
    totalScanned += scanned;
    for (const a of awards) {
      mergeAward(merged, a);
      if (!unlimited && merged.size >= max) break;
    }
    if (!unlimited && merged.size >= max) break;
  }

  let awards = [...merged.values()].sort((a, b) => {
    const da = a.awardDate?.getTime() ?? 0;
    const db = b.awardDate?.getTime() ?? 0;
    if (db !== da) return db - da;
    return b.amount - a.amount;
  });

  if (!unlimited && awards.length > max) awards = awards.slice(0, max);

  const minAward = new Date("2024-01-01T00:00:00Z");
  awards = awards.filter((a) => !a.awardDate || a.awardDate >= minAward);

  const lastYear = yearsTried[0] ?? null;
  return { awards, year: lastYear, years: yearsTried, scanned: totalScanned };
}
