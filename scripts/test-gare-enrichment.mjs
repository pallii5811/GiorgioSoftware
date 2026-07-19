/**
 * Gare ANAC enrichment pipeline — deterministic fixtures, no live network.
 */
import {
  runAnacEnrichmentPipeline,
  enrichmentPipelineStepCount,
  classifyProcurementCategory,
} from "../src/lib/gare/anac-enrichment-pipeline.ts";
import { statusForMissingAwardDate } from "../src/lib/gare/enrichment-status.ts";
import { evaluateGareActionable } from "../src/lib/gare/actionable-gate.ts";
import { estimateCauzione } from "../src/lib/gare/commercial.ts";

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

ok(enrichmentPipelineStepCount() === 17, `17 enrichment steps (got ${enrichmentPipelineStepCount()})`);
ok(classifyProcurementCategory("Lavori edili scuola", "45214200") === "LAVORI", "LAVORI");
ok(classifyProcurementCategory("xyz", null) === "NON_CLASSIFICATO", "NON_CLASSIFICATO");

ok(
  statusForMissingAwardDate({ enrichmentAttempts: 0 }) === "ENRICHMENT_PENDING",
  "missing date → pending"
);
ok(
  statusForMissingAwardDate({ enrichmentAttempts: 3 }) === "NOT_ACTIONABLE",
  "exhausted → not actionable"
);

const pending = runAnacEnrichmentPipeline({
  cig: "ABCDEF1234",
  enrichmentAttempts: 0,
  sourcesRemaining: ["ocds"],
});
ok(pending.state === "ENRICHMENT_PENDING", "no award yet → pending");

const complete = runAnacEnrichmentPipeline({
  cig: "ABCDEF1234",
  knownAward: {
    cig: "ABCDEF1234",
    companyName: "Impresa Alfa Srl",
    amount: 800_000,
    object: "Lavori ristrutturazione padiglione ospedaliero",
    awardDate: new Date("2026-05-01"),
    buyer: "ASL Napoli 1",
    contactsPath: true,
    guaranteeText: "Cauzione definitiva 10% e polizza CAR obbligatoria",
    cpv: "45215100",
  },
});
ok(complete.state === "ACTIONABLE", `complete actionable (got ${complete.state})`);
ok(complete.awardDate != null, "date recovered");
ok(complete.winner === "Impresa Alfa Srl", "winner recovered");
ok(complete.category === "LAVORI", "category recovered");
ok(complete.insuranceNeed === "DOCUMENTED", "insurance documented");
ok(complete.insuranceKind === "FACT", "documented is FACT not estimate");
ok(complete.steps.length === 17, "all steps recorded");

const noDate = runAnacEnrichmentPipeline({
  cig: "ABCDEF1234",
  enrichmentAttempts: 0,
  knownAward: {
    cig: "ABCDEF1234",
    companyName: "Beta",
    amount: 100_000,
    object: "Servizi",
    awardDate: null,
    contactsPath: true,
  },
});
ok(noDate.state === "ENRICHMENT_PENDING", "known award without date → pending");

const revoked = runAnacEnrichmentPipeline({
  cig: "ABCDEF1234",
  knownAward: {
    cig: "ABCDEF1234",
    companyName: "Gamma",
    amount: 100_000,
    object: "Lavori",
    awardDate: new Date(),
    revoked: true,
    contactsPath: true,
    guaranteeText: "cauzione",
  },
});
ok(revoked.state === "NOT_ACTIONABLE", "revoked not actionable");

const est = estimateCauzione(100_000);
ok(est.kind === "ESTIMATE", "stima remains ESTIMATE");

const high = evaluateGareActionable({
  awardDate: complete.awardDate,
  amount: complete.amount || 0,
  hasPhone: true,
  hasEmail: false,
  hasWebsite: true,
  relevance: "HIGH",
  winnerIdentified: true,
  officialSource: true,
  cig: "ABCDEF1234",
  category: "GARE_HIGH",
  insuranceNeed: "DOCUMENTED",
  contactPath: true,
});
ok(high.actionable, "HIGH with gates ok");
ok(
  !evaluateGareActionable({
    awardDate: null,
    amount: 1_000_000,
    hasPhone: true,
    hasEmail: true,
    hasWebsite: true,
    relevance: "HIGH",
    winnerIdentified: true,
    officialSource: true,
    cig: "ABCDEF1234",
    category: "GARE_HIGH",
    insuranceNeed: "DOCUMENTED",
    contactPath: true,
  }).actionable,
  "HIGH without date blocked"
);

console.log(
  JSON.stringify({
    suite: "gare-enrichment",
    exitCode: fail === 0 ? 0 : 1,
    durationMs: Date.now() - start,
    pass,
    fail,
    skipped: 0,
  }, null, 2)
);
process.exit(fail === 0 ? 0 : 1);
