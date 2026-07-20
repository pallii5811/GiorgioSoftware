#!/usr/bin/env node
/**
 * Official Veneto awards ingest for shadow — separate from immutable snapshot.
 * Source: ANAC OCDS via open-contracting.org (same primary as production engine).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { requireShadowIsolation } from "../src/lib/shadow/guard.ts";
import { fetchAnacAwards } from "../src/lib/gare/anac.ts";
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

function stableRank(id) {
  return createHash("sha256").update(`${SEED}:${id}`).digest("hex");
}

const ledger = {
  sourceRunId: RUN_ID,
  acquiredAt: new Date().toISOString(),
  originType: "OFFICIAL_SHADOW_INGEST",
  sourceType: "ANAC_OCDS_open-contracting",
  sourceUrl: "https://data.open-contracting.org/en/publication/117/",
  region: "Veneto",
  scanned: 0,
  awardsRaw: 0,
  withWinner: 0,
  awarded: 0,
  excluded: { noWinner: 0, noCig: 0, noAmount: 0, duplicate: 0 },
  unresolved: 0,
  errors: [],
  records: [],
};

try {
  const { awards, year, years, scanned } = await fetchAnacAwards("Veneto", {
    max: 0,
    years: [2026, 2025, 2024],
  });
  ledger.scanned = scanned;
  ledger.awardsRaw = awards.length;
  ledger.datasetYears = years;
  ledger.primaryYear = year;

  const seen = new Set();
  for (const a of awards) {
    const cig = (a.cig || "").trim().toUpperCase();
    if (!cig) {
      ledger.excluded.noCig++;
      continue;
    }
    if (seen.has(cig)) {
      ledger.excluded.duplicate++;
      continue;
    }
    seen.add(cig);
    if (!a.companyName || a.companyName.trim().length < 3) {
      ledger.excluded.noWinner++;
      continue;
    }
    if (!(a.amount > 0)) {
      ledger.excluded.noAmount++;
      continue;
    }

    ledger.withWinner++;
    ledger.awarded++;

    const relevance = scoreGareRelevance(a.object, a.companyName, a.amount);
    const category = relevanceCategory(relevance);
    const ct = classifyGareContractType({ object: a.object });
    const commercial = scoreGareCommercial({
      awardDate: a.awardDate,
      amount: a.amount,
      hasPhone: false,
      hasEmail: false,
      hasWebsite: false,
      relevance,
      winnerIdentified: true,
      officialSource: true,
    });
    const cauzione = estimateCauzione(a.amount);

    ledger.records.push({
      id: `ingest-veneto-${cig}`,
      origin: {
        originType: "OFFICIAL_SHADOW_INGEST",
        sourceRunId: RUN_ID,
        acquiredAt: ledger.acquiredAt,
        sourceUrl: ledger.sourceUrl,
        sourceType: ledger.sourceType,
      },
      regionCriteria: {
        buyerSaVeneto: true,
        winnerSeatVeneto: null,
        executionPlaceVeneto: null,
      },
      cig,
      lot: null,
      object: a.object,
      winner: a.companyName,
      buyer: a.buyer,
      buyerCity: a.buyerCity,
      amount: a.amount,
      awardDate: a.awardDate?.toISOString?.() || null,
      datasetYear: a.datasetYear,
      category,
      contractType: ct.type,
      contractMethod: ct.method,
      relevance,
      leadScore: computeGareLeadScore(relevance, a.amount, false, false),
      commercialTier: commercial.tier,
      commercialScore: commercial.score,
      cauzioneKind: cauzione.kind,
      cauzioneValue: cauzione.value,
      insuranceNeed: {
        needType: "cauzione_definitiva",
        status: "WEAKLY_INFERRED",
        estimatedAmount: cauzione.value,
        estimateFormula: "10%_importo",
        confidence: 0.4,
      },
      evidence: [
        `Aggiudicazione ANAC ${a.datasetYear}`,
        `CIG ${cig}`,
        a.awardDate ? `Data aggiudicazione: ${a.awardDate.toISOString().slice(0, 10)}` : null,
        a.object?.slice(0, 400),
        a.buyer ? `Stazione appaltante: ${a.buyer}` : null,
        a.buyerCity ? `Comune stazione: ${a.buyerCity}` : null,
        `Importo €${Math.round(a.amount)}`,
        formatContractTypeMarker(ct.type),
        `[ORIGIN:OFFICIAL_SHADOW_INGEST:${RUN_ID}]`,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }
} catch (e) {
  ledger.errors.push(String(e?.message || e).slice(0, 300));
}

// Stratified pick of 25
const ranked = [...ledger.records].sort((a, b) =>
  stableRank(a.cig).localeCompare(stableRank(b.cig))
);
const buckets = { LAVORI: [], SERVIZI: [], FORNITURE: [], OTHER: [] };
for (const r of ranked) {
  if (r.contractType === "LAVORI") buckets.LAVORI.push(r);
  else if (r.contractType === "SERVIZI") buckets.SERVIZI.push(r);
  else if (r.contractType === "FORNITURE") buckets.FORNITURE.push(r);
  else buckets.OTHER.push(r);
}

const selected = [];
const take = (arr, n) => {
  for (const r of arr) {
    if (selected.length >= TARGET) return;
    if (selected.find((x) => x.cig === r.cig)) continue;
    selected.push(r);
    if ([...selected].filter((x) => arr.includes(x)).length >= n && selected.length >= 5) {
      /* soft */
    }
  }
};
for (const [k, n] of [
  ["LAVORI", 6],
  ["SERVIZI", 6],
  ["FORNITURE", 5],
  ["OTHER", 3],
]) {
  let c = 0;
  for (const r of buckets[k]) {
    if (selected.length >= TARGET) break;
    if (selected.find((x) => x.cig === r.cig)) continue;
    selected.push(r);
    c++;
    if (c >= n) break;
  }
}
for (const r of ranked) {
  if (selected.length >= TARGET) break;
  if (!selected.find((x) => x.cig === r.cig)) selected.push(r);
}

ledger.selectedG1 = selected.slice(0, TARGET).map((r) => ({
  cig: r.cig,
  contractType: r.contractType,
  tier: r.commercialTier,
  amount: r.amount,
  id: r.id,
}));

const snapshotVenetoPath = path.join(
  process.cwd(),
  "docs/shadow/batch1/gare-selection-veneto.json"
);
let originalTwo = [];
if (fs.existsSync(snapshotVenetoPath)) {
  originalTwo = JSON.parse(fs.readFileSync(snapshotVenetoPath, "utf8")).ids || [];
}
ledger.originalSnapshotVenetoIds = originalTwo;
ledger.originalIncludedInG1 = false; // G1 Veneto uses OFFICIAL_SHADOW_INGEST set; snapshot 2 kept for comparison
ledger.seed = SEED;

fs.writeFileSync(path.join(OUT_DIR, "veneto-awards-ledger.json"), JSON.stringify(ledger, null, 2));
fs.writeFileSync(
  path.join(OUT_DIR, "veneto-g1-selected.json"),
  JSON.stringify({ seed: SEED, n: ledger.selectedG1.length, selected: ledger.selectedG1, origin: "OFFICIAL_SHADOW_INGEST" }, null, 2)
);
fs.writeFileSync(
  path.join(DOCS, "veneto-ingest-summary.json"),
  JSON.stringify(
    {
      ...ledger,
      records: undefined,
      recordCount: ledger.records.length,
      selectedCount: ledger.selectedG1.length,
    },
    null,
    2
  )
);

console.log(
  JSON.stringify(
    {
      awardsRaw: ledger.awardsRaw,
      records: ledger.records.length,
      selected: ledger.selectedG1.length,
      errors: ledger.errors,
      years: ledger.datasetYears,
    },
    null,
    2
  )
);

if (ledger.selectedG1.length < TARGET) {
  console.error(`Veneto G1 shortfall: ${ledger.selectedG1.length}/${TARGET}`);
  process.exit(2);
}
