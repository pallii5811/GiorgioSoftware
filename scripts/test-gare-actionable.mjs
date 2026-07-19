/**
 * gare-actionable — award/winner/date/estimate gates
 */
import { evaluateGareActionable } from "../src/lib/gare/actionable-gate.ts";
import { relevanceCategory } from "../src/lib/gare/display.ts";
import { estimateCauzione, claimKindLabel } from "../src/lib/gare/commercial.ts";
import { classifyGareContractType } from "../src/lib/gare/contract-type.ts";
import { classifyGarePipelineStatus } from "../src/lib/gare/enrichment-status.ts";

const start = Date.now();
let pass = 0;
let fail = 0;

function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}

ok(relevanceCategory(undefined) === "NON_CLASSIFICATO", "undefined → NON_CLASSIFICATO not GARE_LOW");
ok(relevanceCategory(null) === "NON_CLASSIFICATO", "null → NON_CLASSIFICATO");
ok(relevanceCategory("LOW") === "NON_CLASSIFICATO", "LOW relevance → NON_CLASSIFICATO category");
ok(relevanceCategory("HIGH") === "GARE_HIGH", "HIGH mapped");
ok(!String(relevanceCategory(undefined)).includes("undefined"), "no GARE_undefined");
ok(relevanceCategory("MEDIUM") !== "GARE_LOW", "never emit GARE_LOW as category");

const validInput = {
  awardDate: new Date(),
  amount: 2_000_000,
  hasPhone: true,
  hasEmail: true,
  hasWebsite: true,
  relevance: "HIGH",
  winnerIdentified: true,
  officialSource: true,
  cig: "CIG123",
  lotId: "1",
};
const valid = evaluateGareActionable(validInput);
ok(valid.actionable, `aggiudicazione valida actionable (tier=${valid.tier})`);
ok(valid.category === "GARE_HIGH", "category HIGH");

ok(!evaluateGareActionable({ ...validInput, provisional: true }).actionable, "provvisoria esclusa");
ok(!evaluateGareActionable({ ...validInput, revoked: true }).actionable, "revocata esclusa");
ok(!evaluateGareActionable({ ...validInput, annulled: true }).actionable, "annullata esclusa");
ok(!evaluateGareActionable({ ...validInput, deserted: true }).actionable, "deserta esclusa");
ok(
  !evaluateGareActionable({ ...validInput, winnerIdentified: false }).actionable,
  "vincitore ambiguo escluso"
);
ok(!evaluateGareActionable({ ...validInput, awardDate: null }).actionable, "HIGH senza data escluso");
ok(
  !evaluateGareActionable({ ...validInput, relevance: null, category: "NON_CLASSIFICATO" }).actionable,
  "NON_CLASSIFICATO non actionable"
);
ok(
  !evaluateGareActionable({ ...validInput, category: "GARE_LOW", relevance: "LOW" }).actionable,
  "GARE_LOW category esclusa"
);

ok(
  classifyGarePipelineStatus({
    awardDate: null,
    winnerIdentified: true,
    officialSource: true,
    cig: "CIG1",
    enrichmentAttempts: 0,
  }) === "ENRICHMENT_PENDING",
  "missing date → ENRICHMENT_PENDING not LOW"
);
ok(
  classifyGarePipelineStatus({
    awardDate: null,
    winnerIdentified: true,
    officialSource: true,
    cig: "CIG1",
    enrichmentAttempts: 3,
  }) === "NOT_ACTIONABLE",
  "enrichment exhausted → NOT_ACTIONABLE"
);
ok(
  classifyGarePipelineStatus({
    awardDate: new Date(),
    winnerIdentified: true,
    officialSource: true,
    cig: "CIG1",
  }) === "ACTIONABLE",
  "complete → ACTIONABLE"
);

const est = estimateCauzione(500_000);
ok(est.kind === "ESTIMATE", "cauzione stimata = ESTIMATE");
ok(claimKindLabel(est.kind).toLowerCase().includes("stima"), "label stima non fatto");

const ct = classifyGareContractType({ object: "Lavori di ristrutturazione edificio scolastico" });
ok(ct.type === "LAVORI", `contract type LAVORI (got ${ct.type})`);
ok(ct.type !== "undefined" && !String(ct.type).includes("undefined"), "no undefined contract type");

const elapsed = Date.now() - start;
console.log(
  JSON.stringify(
    { suite: "gare-actionable", exitCode: fail === 0 ? 0 : 1, durationMs: elapsed, pass, fail, skipped: 0 },
    null,
    2
  )
);
process.exit(fail === 0 ? 0 : 1);
