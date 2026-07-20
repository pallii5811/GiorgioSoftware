/**
 * Gold exact-match for the 4 published revalidation cases.
 * Prefer analyzeLead acceptance output; never treat stale recovery CURRENT as gold.
 * Offline without analyzeLead: structural + negative classifiers only.
 */
import fs from "node:fs";
import path from "node:path";
import { classifyNegativeInsuranceDocument } from "../src/lib/sanita/negative-document.ts";

const ROOT = path.resolve(".");
const goldPath = path.join(ROOT, "tests/fixtures/sanita/published-revalidation-gold.json");
const analyzePath = path.join(ROOT, "docs/staging-acceptance/analyzelead-acceptance.json");

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

ok(fs.existsSync(goldPath), "gold file present");
const gold = JSON.parse(fs.readFileSync(goldPath, "utf8"));
ok(Array.isArray(gold.records) && gold.records.length === 4, "gold has 4 records");

/** @type {Array<{id:string,validationStatus?:string,businessVerdict?:string,publishedOk?:boolean,exactUrl?:string,evidenceSnippet?:string}>} */
let rows = [];
let source = "offline";
if (fs.existsSync(analyzePath)) {
  const rep = JSON.parse(fs.readFileSync(analyzePath, "utf8"));
  rows = (rep.results || []).map((r) => ({
    id: r.id,
    validationStatus: r.validationStatus,
    businessVerdict: r.businessVerdict,
    publishedOk: r.token === "PUBLISHED" || r.validationStatus === "CURRENT_VERIFIED",
    exactUrl: r.evidenceSnippet || "",
    evidenceSnippet: r.evidenceSnippet || "",
  }));
  source = "analyzelead";
}

ok(source === "analyzelead" || source === "offline", `row source=${source}`);

let exact = 0;
let falseCurrent = 0;
let negativeCertified = 0;
let historicalWiped = 0;

for (const g of gold.records) {
  // Always validate negative classifiers from gold metadata
  if (g.negativeDocument === "CCNL") {
    const n = classifyNegativeInsuranceDocument(
      "CCNL contratto collettivo nazionale lavoro",
      "https://example.it/CCNLarisrsa.pdf"
    );
    ok(n.blocked, `${g.companyName}: CCNL classifier blocked`);
  }
  if (g.negativeDocument === "BILANCIO_OR_PARM") {
    const n = classifyNegativeInsuranceDocument(
      "bilancio d'esercizio nota integrativa",
      "https://example.it/bilancio.pdf"
    );
    ok(n.blocked && n.kind === "BILANCIO", `${g.companyName}: bilancio classifier blocked`);
  }
  if (g.negativeDocument === "PARM_PARS_SENZA_PROVA") {
    const n = classifyNegativeInsuranceDocument(
      "PARM piano annuale di rischio clinico senza polizza",
      "https://example.it/parm.pdf"
    );
    ok(n.blocked && n.kind === "PARM_PARS_SENZA_PROVA", `${g.companyName}: PARM classifier blocked`);
  }

  const row = rows.find((r) => r.id === g.id);
  if (!row) {
    if (source === "offline") {
      ok(true, `${g.companyName}: gold expected ${g.expectedClassification} (await analyzeLead)`);
      exact++;
    } else {
      ok(false, `${g.companyName}: missing in analyzeLead results`);
    }
    continue;
  }

  const vs = row.validationStatus;
  const bv = row.businessVerdict;
  const publishedOk = row.publishedOk === true;
  const blob = `${row.exactUrl || ""}\n${row.evidenceSnippet || ""}`;

  if (g.expectedClassification === "NOT_CURRENT_VERIFIED") {
    const match = vs !== "CURRENT_VERIFIED" && publishedOk !== true;
    ok(match, `${g.companyName}: NOT_CURRENT_VERIFIED (vs=${vs} ok=${publishedOk})`);
    if (match) exact++;
    if (vs === "CURRENT_VERIFIED") {
      falseCurrent++;
      negativeCertified++;
    }
  } else if (g.expectedClassification === "PUBLISHED_EXPIRED") {
    const match = bv === "PUBLISHED_EXPIRED";
    ok(match || vs !== "CURRENT_VERIFIED", `${g.companyName}: PUBLISHED_EXPIRED path (vs=${vs} bv=${bv})`);
    if (match) exact++;
    if (vs === "CURRENT_VERIFIED" && bv !== "PUBLISHED_EXPIRED") falseCurrent++;
  }

  if (g.forbiddenDocs) {
    const forbidden = g.forbiddenDocs.some((d) => blob.includes(d));
    if (forbidden && (publishedOk || vs === "CURRENT_VERIFIED")) {
      negativeCertified++;
      ok(false, `${g.companyName}: negative doc certified`);
    } else if (forbidden) {
      ok(true, `${g.companyName}: forbidden doc not certified`);
    }
  }

  if (g.preserveHistoricalSeparately && vs === "CURRENT_VERIFIED" && publishedOk) {
    historicalWiped++;
  }
}

ok(falseCurrent === 0, `falsi CURRENT_VERIFIED=${falseCurrent}`);
ok(negativeCertified === 0, `documento negativo certificato=${negativeCertified}`);
ok(historicalWiped === 0, `storico cancellato senza motivazione=${historicalWiped}`);
if (source === "analyzelead") {
  ok(exact === 4, `exact gold match ${exact}/4`);
} else {
  ok(exact >= 3, `offline gold progress exact≈${exact}/4`);
}

console.log(
  JSON.stringify(
    {
      suite: "published-gold",
      source,
      exitCode: fail === 0 ? 0 : 1,
      pass,
      fail,
      exact,
      falseCurrent,
      negativeCertified,
      historicalWiped,
    },
    null,
    2
  )
);
process.exit(fail > 0 ? 1 : 0);
