/**
 * Gare positive control — frozen official corpus recall/precision gates.
 */
import fs from "node:fs";
import path from "node:path";
import { evaluateGareActionable } from "../src/lib/gare/actionable-gate.ts";
import { runAnacEnrichmentPipeline } from "../src/lib/gare/anac-enrichment-pipeline.ts";

const start = Date.now();
let pass = 0;
let fail = 0;
function ok(c, m) {
  if (c) {
    pass++;
    console.log(`  ✓ ${m}`);
  } else {
    fail++;
    console.error(`  ✗ ${m}`);
  }
}

const fixturePath = path.join("tests/fixtures/gare/gare-positive-control.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const records = fixture.records || [];

ok(records.filter((r) => r.region === "Campania").length >= 5, "at least 5 Campania controls");
ok(records.filter((r) => r.region === "Veneto").length >= 5, "at least 5 Veneto controls");

let expectedActionable = 0;
let recalled = 0;
let falseActionable = 0;
let provenanceComplete = 0;

for (const rec of records) {
  for (const key of ["cig", "awardDate", "winner", "amount", "object"]) {
    const claim = rec[key];
    ok(claim && claim.kind && claim.sourceUrl, `provenance field ${rec.id}.${key}`);
    if (claim?.kind && claim?.sourceUrl) provenanceComplete++;
  }

  const awardDate = rec.awardDate?.value ? new Date(rec.awardDate.value) : null;
  const enrich = runAnacEnrichmentPipeline({
    cig: rec.cig.value,
    region: rec.region,
    knownAward: {
      cig: rec.cig.value,
      companyName: rec.winner.value,
      amount: rec.amount.value,
      object: rec.object.value,
      awardDate: rec.awardDate.value || undefined,
      contactsPath: Boolean(rec.hasPhone || rec.hasEmail || rec.hasWebsite || rec.contactPath),
      guaranteeText: /cauzione|garanzia|polizza/i.test(rec.object.value) ? "cauzione" : null,
    },
  });

  const gate = evaluateGareActionable({
    awardDate: enrich.awardDate || awardDate,
    amount: enrich.amount ?? rec.amount.value ?? 0,
    hasPhone: Boolean(rec.hasPhone),
    hasEmail: Boolean(rec.hasEmail),
    hasWebsite: Boolean(rec.hasWebsite),
    relevance: rec.relevance,
    winnerIdentified: Boolean(rec.winner?.value),
    officialSource: Boolean(rec.officialSource || enrich.officialSource),
    cig: rec.cig.value,
    category: rec.category,
    insuranceNeed: rec.insuranceNeed,
    contactPath: Boolean(rec.contactPath || rec.hasPhone || rec.hasEmail || rec.hasWebsite),
  });

  if (rec.expectedActionable) {
    expectedActionable++;
    if (gate.actionable) recalled++;
    ok(gate.actionable === true, `recall ${rec.id}`);
  } else {
    if (gate.actionable) falseActionable++;
    ok(!gate.actionable, `no false actionable ${rec.id}`);
  }
}

const recall = expectedActionable ? recalled / expectedActionable : 0;
ok(recall > 0, `positive-control recall > 0 (${recalled}/${expectedActionable})`);
ok(falseActionable === 0, `false actionable = 0`);
ok(provenanceComplete >= records.length * 5, "provenance completeness on frozen controls");

const elapsed = Date.now() - start;
console.log(
  JSON.stringify(
    {
      suite: "gare-positive-control",
      exitCode: fail === 0 ? 0 : 1,
      durationMs: elapsed,
      pass,
      fail,
      skipped: 0,
      recall,
      falseActionable,
    },
    null,
    2
  )
);
process.exit(fail === 0 ? 0 : 1);
