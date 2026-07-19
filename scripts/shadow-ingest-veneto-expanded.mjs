#!/usr/bin/env node
/**
 * Expanded Veneto ANAC ingest — CAP + locality matching; ledger includes incompletes.
 * Separate OFFICIAL_SHADOW_INGEST dataset (does not mutate immutable snapshot semantics).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { requireShadowIsolation } from "../src/lib/shadow/guard.ts";
import { externalFetch } from "../src/lib/http.ts";
import {
  classifyGareContractType,
  formatContractTypeMarker,
} from "../src/lib/gare/contract-type.ts";
import { scoreGareRelevance, computeGareLeadScore } from "../src/lib/gare/relevance.ts";
import { estimateCauzione, scoreGareCommercial } from "../src/lib/gare/commercial.ts";
import { relevanceCategory } from "../src/lib/gare/display.ts";

requireShadowIsolation();

const RUN_ID = process.env.SHADOW_RUN_ID || "shadow-veneto-ingest-20260718";
const OUT_DIR = path.join(process.cwd(), "data/shadow/ingest");
const DOCS = path.join(process.cwd(), "docs/shadow/batch1-completion");
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(DOCS, { recursive: true });

const SEED = 20260719;
const TARGET = 25;
const VENETO_CAP = new Set(["30", "31", "32", "35", "36", "37", "45"]);
const VENETO_CITY =
  /\b(venezia|verona|padova|padua|vicenza|treviso|rovigo|belluno|mestre|mirano|chioggia|bassano|schio|thiene|legnago|san\s+don[aà]|castelfranco|montebelluna|coneegliano|oderzo|jesolo|portogruaro|adria|chioggia|feltre|cortina)\b/i;

const DATASET_URL = (year) =>
  `https://data.open-contracting.org/en/publication/117/download?name=${year}.jsonl.gz`;

function stableRank(id) {
  return createHash("sha256").update(`${SEED}:${id}`).digest("hex");
}

function isVenetoBuyer(party) {
  const cap = String(party?.address?.postalCode || "").trim();
  if (/^\d{5}$/.test(cap) && VENETO_CAP.has(cap.slice(0, 2))) return { ok: true, via: "cap" };
  const loc = String(party?.address?.locality || "");
  if (VENETO_CITY.test(loc)) return { ok: true, via: "locality" };
  const name = String(party?.name || "");
  if (/ulss|asugi|aulss|regione\s+veneto|comune\s+di\s+(venezia|verona|padova|vicenza|treviso|rovigo|belluno)/i.test(name)) {
    return { ok: true, via: "buyer_name" };
  }
  return { ok: false, via: null };
}

function pickCig(award) {
  const candidates = [...(award?.relatedLots || []), ...(award?.items || []).map((i) => i?.id)];
  for (const c of candidates) {
    if (typeof c === "string" && /^[A-Z0-9]{10}$/i.test(c.trim())) return c.trim().toUpperCase();
  }
  return null;
}

async function downloadYear(year) {
  const res = await externalFetch(DATASET_URL(year), { timeoutMs: 120_000, redirect: "follow" });
  if (!res.ok) return null;
  const gz = Buffer.from(await res.arrayBuffer());
  if (!gz.length) return null;
  return gunzipSync(gz).toString("utf-8");
}

const ledger = {
  sourceRunId: RUN_ID,
  acquiredAt: new Date().toISOString(),
  originType: "OFFICIAL_SHADOW_INGEST",
  sourceType: "ANAC_OCDS_open-contracting",
  sourceUrl: "https://data.open-contracting.org/en/publication/117/",
  region: "Veneto",
  years: [],
  scannedLines: 0,
  regionMatched: 0,
  awardsRaw: 0,
  records: [],
  incomplete: [],
  excluded: { noCig: 0, noWinner: 0, duplicate: 0 },
  errors: [],
};

const seen = new Set();

for (const year of [2025, 2024, 2023]) {
  let jsonl;
  try {
    jsonl = await downloadYear(year);
  } catch (e) {
    ledger.errors.push(`download ${year}: ${String(e.message || e).slice(0, 120)}`);
    continue;
  }
  if (!jsonl) {
    ledger.errors.push(`empty ${year}`);
    continue;
  }
  ledger.years.push(year);

  for (const line of jsonl.split("\n")) {
    if (!line) continue;
    ledger.scannedLines++;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const release = obj.compiledRelease ?? obj.releases?.[0] ?? obj;
    const awardsArr = Array.isArray(release.awards) ? release.awards : [];
    if (!awardsArr.length) continue;

    const buyerParty =
      release.parties?.find((p) => p.roles?.includes("buyer")) ?? release.parties?.[0];
    const match = isVenetoBuyer(buyerParty || {});
    if (!match.ok) continue;
    ledger.regionMatched++;

    for (const a of awardsArr) {
      if (a?.status && a.status !== "active") {
        ledger.incomplete.push({ year, status: a.status, reason: "non_active" });
        continue;
      }
      const cig = pickCig(a);
      if (!cig) {
        ledger.excluded.noCig++;
        continue;
      }
      if (seen.has(cig)) {
        ledger.excluded.duplicate++;
        continue;
      }
      const supplier = a.suppliers?.[0]?.name;
      if (typeof supplier !== "string" || supplier.trim().length < 3) {
        ledger.excluded.noWinner++;
        ledger.incomplete.push({ cig, reason: "no_winner", year });
        continue;
      }
      seen.add(cig);
      const amount = Number(a.value?.amount) || 0;
      const object = (a.items?.[0]?.description || release?.tender?.description || "Appalto pubblico").trim();
      const awardDate = a.date || a.contractPeriod?.startDate || release.date || null;
      const ad = awardDate ? new Date(awardDate) : null;
      // Prefer 2024+ for G1 but keep older in ledger
      const relevance = scoreGareRelevance(object, supplier, amount);
      const category = relevanceCategory(relevance);
      const ct = classifyGareContractType({ object });
      const commercial = scoreGareCommercial({
        awardDate: ad && !Number.isNaN(ad.getTime()) ? ad : null,
        amount,
        hasPhone: false,
        hasEmail: false,
        hasWebsite: false,
        relevance,
        winnerIdentified: true,
        officialSource: true,
      });
      const cauzione = estimateCauzione(amount || 0);
      const rec = {
        id: `ingest-veneto-${cig}`,
        origin: {
          originType: "OFFICIAL_SHADOW_INGEST",
          sourceRunId: RUN_ID,
          acquiredAt: ledger.acquiredAt,
          sourceUrl: ledger.sourceUrl,
          sourceType: ledger.sourceType,
        },
        regionMatchVia: match.via,
        regionCriteria: { buyerSaVeneto: true, winnerSeatVeneto: null, executionPlaceVeneto: null },
        cig,
        object: object.slice(0, 400),
        winner: supplier.trim(),
        buyer: buyerParty?.name || null,
        buyerCity: buyerParty?.address?.locality || null,
        buyerCap: buyerParty?.address?.postalCode || null,
        amount,
        awardDate: ad && !Number.isNaN(ad.getTime()) ? ad.toISOString() : null,
        datasetYear: year,
        category,
        contractType: ct.type,
        relevance,
        leadScore: computeGareLeadScore(relevance, amount, false, false),
        commercialTier: commercial.tier,
        commercialScore: commercial.score,
        cauzioneKind: cauzione.kind,
        cauzioneValue: cauzione.value,
        insuranceNeed: {
          needType: "cauzione_definitiva",
          status: amount > 0 ? "WEAKLY_INFERRED" : "NOT_FOUND",
          estimatedAmount: amount > 0 ? cauzione.value : undefined,
          estimateFormula: amount > 0 ? "10%_importo" : undefined,
          confidence: amount > 0 ? 0.4 : 0,
        },
        evidence: [
          `Aggiudicazione ANAC ${year}`,
          `CIG ${cig}`,
          ad && !Number.isNaN(ad.getTime()) ? `Data aggiudicazione: ${ad.toISOString().slice(0, 10)}` : null,
          object.slice(0, 300),
          buyerParty?.name ? `Stazione appaltante: ${buyerParty.name}` : null,
          `Importo €${Math.round(amount)}`,
          formatContractTypeMarker(ct.type),
          `[ORIGIN:OFFICIAL_SHADOW_INGEST:${RUN_ID}]`,
        ]
          .filter(Boolean)
          .join(" · "),
      };
      ledger.records.push(rec);
      ledger.awardsRaw++;
    }
  }
}

// Prefer amount>0 and awardDate >= 2024 for G1 selection
const eligible = ledger.records
  .filter((r) => r.amount > 0)
  .filter((r) => !r.awardDate || new Date(r.awardDate) >= new Date("2024-01-01"))
  .sort((a, b) => stableRank(a.cig).localeCompare(stableRank(b.cig)));

const fallback = ledger.records
  .filter((r) => r.amount > 0 && !eligible.find((e) => e.cig === r.cig))
  .sort((a, b) => stableRank(a.cig).localeCompare(stableRank(b.cig)));

const pool = [...eligible, ...fallback];
const selected = [];
const buckets = { LAVORI: [], SERVIZI: [], FORNITURE: [], OTHER: [] };
for (const r of pool) {
  (buckets[r.contractType] || buckets.OTHER).push(r);
}
for (const [k, n] of [
  ["LAVORI", 6],
  ["SERVIZI", 6],
  ["FORNITURE", 5],
  ["OTHER", 8],
]) {
  let c = 0;
  for (const r of buckets[k] || []) {
    if (selected.length >= TARGET) break;
    if (selected.find((x) => x.cig === r.cig)) continue;
    selected.push(r);
    c++;
    if (c >= n) break;
  }
}
for (const r of pool) {
  if (selected.length >= TARGET) break;
  if (!selected.find((x) => x.cig === r.cig)) selected.push(r);
}

ledger.selectedG1 = selected.slice(0, TARGET);
ledger.seed = SEED;
ledger.originalSnapshotVenetoIds = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "docs/shadow/batch1/gare-selection-veneto.json"), "utf8")
).ids;
ledger.originalIncludedInG1 = false;

fs.writeFileSync(path.join(OUT_DIR, "veneto-awards-ledger.json"), JSON.stringify({ ...ledger, incomplete: ledger.incomplete.slice(0, 100) }, null, 2));
fs.writeFileSync(
  path.join(OUT_DIR, "veneto-g1-selected.json"),
  JSON.stringify(
    {
      seed: SEED,
      n: ledger.selectedG1.length,
      origin: "OFFICIAL_SHADOW_INGEST",
      selected: ledger.selectedG1,
    },
    null,
    2
  )
);
fs.writeFileSync(
  path.join(DOCS, "veneto-ingest-summary.json"),
  JSON.stringify(
    {
      sourceRunId: RUN_ID,
      years: ledger.years,
      scannedLines: ledger.scannedLines,
      regionMatched: ledger.regionMatched,
      awardsRaw: ledger.awardsRaw,
      selected: ledger.selectedG1.length,
      excluded: ledger.excluded,
      errors: ledger.errors,
      originalSnapshotVenetoIds: ledger.originalSnapshotVenetoIds,
      originalIncludedInG1: false,
    },
    null,
    2
  )
);

console.log(
  JSON.stringify(
    {
      years: ledger.years,
      regionMatched: ledger.regionMatched,
      awardsRaw: ledger.awardsRaw,
      selected: ledger.selectedG1.length,
      errors: ledger.errors,
    },
    null,
    2
  )
);
process.exit(ledger.selectedG1.length >= TARGET ? 0 : 2);
