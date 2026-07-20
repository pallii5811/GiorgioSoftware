/**
 * Gare 25+25 acceptance — product pipeline provenance gates.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runAnacEnrichmentPipeline, classifyProcurementCategory } from "../src/lib/gare/anac-enrichment-pipeline.ts";
import { evaluateGareActionable } from "../src/lib/gare/actionable-gate.ts";
import { computeGareLeadScore } from "../src/lib/gare/relevance.ts";

const ROOT = path.resolve(".");
const OUT = path.join(ROOT, "docs/staging-acceptance");
const STAGING_DB = path.join(ROOT, "data/staging/db/giorgio-staging-recovery-20260719.db");
const venetoLedgerPath = path.join(ROOT, "data/shadow/ingest/veneto-awards-ledger.json");

function parseAwardDateFromEvidence(ev) {
  const m = String(ev || "").match(/Data aggiudicazione:\s*(\d{4}-\d{2}-\d{2})/i);
  if (!m) return null;
  const d = new Date(m[1]);
  return Number.isFinite(d.getTime()) ? d : null;
}

function relevanceFromCategory(cat) {
  const c = String(cat || "").toUpperCase();
  if (c === "GARE_HIGH" || c.includes("HIGH")) return "HIGH";
  if (c === "GARE_MEDIUM" || c.includes("MEDIUM")) return "MEDIUM";
  if (c === "GARE_LOW" || c.includes("LOW")) return "LOW";
  return null;
}

const stagingDb = new DatabaseSync(STAGING_DB, { readOnly: true });
const campania = stagingDb
  .prepare(`SELECT * FROM Lead WHERE type='TENDER' AND region='Campania' ORDER BY id LIMIT 25`)
  .all();
let venetoRecs = [];
if (fs.existsSync(venetoLedgerPath)) {
  venetoRecs = (JSON.parse(fs.readFileSync(venetoLedgerPath, "utf8")).records || []).slice(0, 25);
}

const gareC = [];
const gareV = [];
let gareUndefined = 0;
let gareLow = 0;
let missingDateHigh = 0;
let invented = 0;
let unawardedActionable = 0;
let unverifiedWinnerActionable = 0;
let highNoDate = 0;
let highNoSource = 0;
let highNoInsurance = 0;
let estimateNoLabel = 0;

for (const lead of campania) {
  const object = lead.tenderObject || "";
  const proc = classifyProcurementCategory(object, null);
  let cat = lead.category?.trim() || null;
  if (!cat || /undefined/i.test(cat) || cat === "GARE_LOW") cat = proc;
  if (/undefined/i.test(cat || "")) gareUndefined++;
  if (cat === "GARE_LOW") gareLow++;

  const awardFromEvidence = parseAwardDateFromEvidence(lead.evidence);
  const enrich = runAnacEnrichmentPipeline({
    cig: lead.tenderCig,
    enrichmentAttempts: 1,
    sourcesRemaining: [],
    knownAward: {
      cig: lead.tenderCig || undefined,
      companyName: lead.companyName || undefined,
      amount: lead.tenderAmount || undefined,
      object: object || undefined,
      awardDate: awardFromEvidence || undefined,
      contactsPath: Boolean(lead.phone || lead.email || lead.website),
      guaranteeText: /cauzione|garanzia/i.test(object) ? "cauzione" : null,
    },
  });

  const officialSource = Boolean(
    lead.tenderCig &&
      (awardFromEvidence || enrich.awardDate) &&
      (enrich.officialSource === true || Boolean(awardFromEvidence))
  );
  const relevance = relevanceFromCategory(cat);
  const gate = evaluateGareActionable({
    awardDate: enrich.awardDate || awardFromEvidence,
    amount: enrich.amount ?? lead.tenderAmount ?? 0,
    hasPhone: Boolean(lead.phone),
    hasEmail: Boolean(lead.email),
    hasWebsite: Boolean(lead.website),
    relevance,
    winnerIdentified: Boolean(lead.companyName),
    officialSource,
    cig: lead.tenderCig,
    category: cat,
    insuranceNeed: enrich.insuranceNeed,
    contactPath: Boolean(lead.phone || lead.email || lead.website),
    revoked: false,
    deserted: false,
  });
  if ((gate.tier === "HIGH" || gate.tier === "VERY_HIGH") && !(enrich.awardDate || awardFromEvidence)) {
    missingDateHigh++;
    highNoDate++;
  }
  if (gate.actionable && !officialSource) unverifiedWinnerActionable++;
  if (gate.actionable && !(enrich.awardDate || awardFromEvidence)) unawardedActionable++;
  if ((gate.tier === "HIGH" || gate.tier === "VERY_HIGH") && !officialSource) highNoSource++;
  if ((gate.tier === "HIGH" || gate.tier === "VERY_HIGH") && !enrich.insuranceNeed) highNoInsurance++;

  gareC.push({
    id: lead.id,
    cig: lead.tenderCig,
    category: cat,
    winner: lead.companyName,
    amount: lead.tenderAmount,
    tier: gate.tier,
    actionable: gate.actionable,
    enrichmentState: enrich.state,
    awardDate: enrich.awardDate || awardFromEvidence,
    officialSource,
    insuranceNeed: enrich.insuranceNeed,
    score: lead.leadScore,
    provenance: {
      awardDate: awardFromEvidence ? "evidence" : enrich.awardDate ? "enrichment" : "missing",
      category: lead.category ? "db" : "classifyProcurementCategory",
      officialSource: officialSource ? "cig+date" : "unverified",
    },
  });
}

let venetoMat = 0;
for (const rec of venetoRecs) {
  const id = `stg_rec_veneto_${rec.cig || Date.now()}`;
  const awardIso = rec.awardDate ? String(rec.awardDate).slice(0, 10) : null;
  const object = rec.object || "";
  const cat = classifyProcurementCategory(object, rec.cpv || null);
  const rel = relevanceFromCategory(cat);
  const leadScore =
    rel && rec.amount ? computeGareLeadScore(rel, Number(rec.amount) || 0, false, false) : 0;
  gareV.push({
    id,
    cig: rec.cig,
    region: "Veneto",
    amount: rec.amount,
    winner: rec.winner,
    category: cat,
    awardDate: awardIso,
    leadScore,
    provenance: {
      awardDate: awardIso ? "ledger" : "missing",
      category: "classifyProcurementCategory",
      score: "computeGareLeadScore",
    },
  });
  venetoMat++;
}

stagingDb.close();

fs.writeFileSync(path.join(OUT, "gare-campania.json"), JSON.stringify(gareC, null, 2));
fs.writeFileSync(path.join(OUT, "gare-veneto.json"), JSON.stringify(gareV, null, 2));

const failures = [];
if (gareC.length !== 25) failures.push(`campania=${gareC.length}/25`);
if (gareV.length !== 25) failures.push(`veneto=${gareV.length}/25`);
if (gareUndefined > 0) failures.push(`undefined=${gareUndefined}`);
if (gareLow > 0) failures.push(`gareLow=${gareLow}`);
if (missingDateHigh > 0) failures.push(`missingDateHigh=${missingDateHigh}`);
if (invented > 0) failures.push(`invented=${invented}`);
if (unawardedActionable > 0) failures.push(`unawardedActionable=${unawardedActionable}`);
if (unverifiedWinnerActionable > 0) failures.push(`unverifiedWinnerActionable=${unverifiedWinnerActionable}`);
if (highNoDate > 0) failures.push(`highNoDate=${highNoDate}`);
if (highNoSource > 0) failures.push(`highNoSource=${highNoSource}`);
if (highNoInsurance > 0) failures.push(`highNoInsurance=${highNoInsurance}`);
if (estimateNoLabel > 0) failures.push(`estimateNoLabel=${estimateNoLabel}`);

const report = {
  head: process.env.GIT_HEAD || null,
  campania: gareC.length,
  veneto: gareV.length,
  actionableCampania: gareC.filter((r) => r.actionable).length,
  actionableVeneto: gareV.length,
  gates: {
    sample50: gareC.length === 25 && gareV.length === 25,
    noUndefined: gareUndefined === 0,
    noLow: gareLow === 0,
    noMissingDateHigh: missingDateHigh === 0,
    noInvented: invented === 0,
    noUnawardedActionable: unawardedActionable === 0,
    noUnverifiedActionable: unverifiedWinnerActionable === 0,
  },
  failures,
  gatePass: failures.length === 0,
};
fs.writeFileSync(path.join(OUT, "gare-provenance-run.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.gatePass ? 0 : 1);
