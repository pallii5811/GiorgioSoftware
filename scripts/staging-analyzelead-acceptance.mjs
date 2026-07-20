/**
 * Staging acceptance via REAL analyzeLead (product path).
 * Copies staging DB → Prisma DATABASE_URL, FORCE_RESCAN_PUB=true, observes DB rows.
 * Does not invent verdicts in the script.
 *
 * Env:
 *   STAGING_ONLY=published|hot|hard|all (default all)
 *   STAGING_LIMIT=N (optional max leads)
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(".");
const OUT = path.join(ROOT, "docs/staging-acceptance");
const SAMPLE = path.join(OUT, "sample-sanita.json");
const GOLD = path.join(ROOT, "tests/fixtures/sanita/published-revalidation-gold.json");
const SRC_DB = path.join(ROOT, "data/staging/db/giorgio-staging-recovery-20260719.db");
const DST_DB = path.join(ROOT, "data/staging/db/giorgio-analyzelead-acceptance.db");
const FRONTIER = path.join(ROOT, "data/staging/frontier/analyzelead-acceptance.sqlite");

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.dirname(DST_DB), { recursive: true });
fs.mkdirSync(path.dirname(FRONTIER), { recursive: true });

if (!fs.existsSync(SAMPLE)) {
  console.error("sample-sanita.json missing");
  process.exit(1);
}
if (!fs.existsSync(SRC_DB)) {
  console.error("staging DB missing — copy shadow backup first");
  process.exit(1);
}

fs.copyFileSync(SRC_DB, DST_DB);
// Fresh frontier each acceptance — never resume a killed OCR run
if (fs.existsSync(FRONTIER)) fs.unlinkSync(FRONTIER);

process.env.STAGING_MODE = "true";
process.env.DISABLE_LIVE_DB = "true";
process.env.DISABLE_EMAILS = "true";
process.env.FORCE_RESCAN_PUB = "true";
process.env.DATABASE_URL = `file:${DST_DB.replace(/\\/g, "/")}`;
process.env.FRONTIER_DB_PATH = FRONTIER;
process.env.SHADOW_RUN_ID = "analyzelead-acceptance";
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

const sample = JSON.parse(fs.readFileSync(SAMPLE, "utf8"));
const gold = JSON.parse(fs.readFileSync(GOLD, "utf8"));
const only = (process.env.STAGING_ONLY || "all").toLowerCase();
const buckets = [];
if (only === "all" || only === "published") buckets.push(...(sample.published || []));
if (only === "all" || only === "hot") buckets.push(...(sample.hot || []));
if (only === "all" || only === "hard") buckets.push(...(sample.hard || []));
let ids = buckets.map((r) => r.id);
const lim = Number(process.env.STAGING_LIMIT || 0);
if (lim > 0) ids = ids.slice(0, lim);

const { prisma } = await import("../src/lib/prisma.ts");
const { analyzeLead } = await import("../src/lib/sanita/scan-engine.ts");
const { readVerdictToken } = await import("../src/lib/sanita/verdict.ts");
const { readProcessingState, readBusinessVerdict, readValidationStatus } = await import(
  "../src/lib/sanita/processing-state.ts"
);

function readFrontierTrace(leadId) {
  if (!fs.existsSync(FRONTIER)) return null;
  try {
    const db = new DatabaseSync(FRONTIER, { readOnly: true });
    const run = db
      .prepare(`SELECT * FROM CrawlRun WHERE leadId = ? ORDER BY startedAt DESC LIMIT 1`)
      .get(leadId);
    if (!run) {
      db.close();
      return null;
    }
    const nodes = db
      .prepare(
        `SELECT canonicalUrl, state, resourceType, discoverySource, lastError FROM CrawlFrontierNode WHERE crawlRunId = ?`
      )
      .all(run.id);
    db.close();
    return {
      crawlRunId: run.id,
      sitemapStatus: run.sitemapStatus,
      urlCapReached: !!run.urlCapReached,
      timeCapReached: !!run.timeCapReached,
      identityVerified: !!run.identityVerified,
      scopeVerified: !!run.scopeVerified,
      nodeCount: nodes.length,
      retryPending: nodes.filter((n) => n.state === "RETRY_PENDING").length,
      failed: nodes.filter((n) => n.state === "TECHNICAL_BLOCKED").length,
      playwrightSources: nodes.filter((n) => /playwright/i.test(n.discoverySource || "")).length,
      xhrJson: nodes.filter((n) => /xhr|json/i.test(n.discoverySource || "") || /\.json/i.test(n.canonicalUrl)).length,
      sampleUrls: nodes.slice(0, 12).map((n) => ({ url: n.canonicalUrl, state: n.state, src: n.discoverySource })),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

const report = {
  head: process.env.GIT_HEAD || null,
  startedAt: new Date().toISOString(),
  only,
  ids,
  results: [],
  gates: {},
  failures: [],
};

function fail(g, m) {
  report.failures.push({ gate: g, msg: m });
  report.gates[g] = false;
  console.error(`FAIL [${g}] ${m}`);
}
function pass(g, m) {
  report.gates[g] = true;
  console.log(`PASS [${g}] ${m}`);
}

let falsePub = 0;
let falseHot = 0;
let techAsHuman = 0;
let goldExact = 0;
let hotComplete = 0;

for (const id of ids) {
  const before = await prisma.lead.findUnique({ where: { id } });
  if (!before) {
    report.results.push({ id, error: "missing_in_db" });
    continue;
  }
  const counters = {
    analyzed: 0,
    withPolicy: 0,
    published: 0,
    hot: 0,
    review: 0,
    reviewHuman: 0,
    retryPending: 0,
    technicalBlocked: 0,
    outOfScope: 0,
  };
  const t0 = Date.now();
  console.log(`\n>>> analyzeLead ${before.companyName} (${id})`);
  try {
    await analyzeLead(
      {
        id: before.id,
        osmId: before.osmId,
        category: before.category,
        companyName: before.companyName,
        city: before.city,
        region: before.region,
        website: before.website,
        phone: before.phone,
        email: before.email,
        pec: before.pec,
        piva: before.piva,
      },
      counters
    );
  } catch (e) {
    report.results.push({
      id,
      companyName: before.companyName,
      error: e instanceof Error ? e.message : String(e),
      wallMs: Date.now() - t0,
    });
    continue;
  }
  const after = await prisma.lead.findUnique({ where: { id } });
  const evidence = after?.evidence || "";
  const token = readVerdictToken(evidence);
  const state = readProcessingState(evidence);
  const bv = readBusinessVerdict(evidence);
  const vs = readValidationStatus(evidence);
  const frontier = readFrontierTrace(id);
  const row = {
    id,
    companyName: after?.companyName,
    website: after?.website,
    input: {
      website: before.website,
      city: before.city,
      piva: before.piva,
    },
    token,
    businessVerdict: bv,
    validationStatus: vs,
    processingState: state,
    policyCompany: after?.policyCompany,
    policyNumber: after?.policyNumber,
    policyExpiry: after?.policyExpiry,
    evidenceSnippet: evidence.slice(0, 800),
    crawlComplete: /\[CRAWL_COMPLETE:true\]/i.test(evidence),
    frontier,
    counters,
    wallMs: Date.now() - t0,
  };
  report.results.push(row);

  if (state === "RETRY_PENDING" && token === "REVIEW") techAsHuman++;
  if (token === "HOT" && /\[CRAWL_COMPLETE:false\]/i.test(evidence)) falseHot++;
  if (token === "HOT" && /\[CRAWL_COMPLETE:true\]/i.test(evidence)) hotComplete++;

  const g = gold.records.find((x) => x.id === id);
  if (g) {
    if (g.expectedClassification === "NOT_CURRENT_VERIFIED") {
      if (vs !== "CURRENT_VERIFIED" && bv !== "PUBLISHED_CURRENT") goldExact++;
      else {
        falsePub++;
        fail("gold", `${g.companyName} unexpectedly CURRENT`);
      }
    }
    if (g.expectedClassification === "PUBLISHED_EXPIRED") {
      if (bv === "PUBLISHED_EXPIRED") goldExact++;
      else if (vs === "CURRENT_VERIFIED" && bv === "PUBLISHED_CURRENT") {
        falsePub++;
        fail("gold", `${g.companyName} CURRENT but expected EXPIRED`);
      }
    }
    if (g.forbiddenDocs && evidence) {
      for (const d of g.forbiddenDocs) {
        if (evidence.includes(d) && vs === "CURRENT_VERIFIED") {
          falsePub++;
          fail("gold", `${g.companyName} forbidden doc ${d} CURRENT`);
        }
      }
    }
  }
  console.log(
    `OK ${before.companyName} → ${token}/${bv}/${vs}/${state} sitemap=${frontier?.sitemapStatus} ${row.wallMs}ms`
  );
  fs.writeFileSync(path.join(OUT, "analyzelead-acceptance.json"), JSON.stringify(report, null, 2));
}

if (falsePub === 0) pass("false_published", "0");
else fail("false_published", String(falsePub));
if (falseHot === 0) pass("false_hot", "0");
else fail("false_hot", String(falseHot));
if (techAsHuman === 0) pass("tech_as_human", "0");
else fail("tech_as_human", String(techAsHuman));

const publishedIds = new Set((sample.published || []).map((r) => r.id));
const ranPublished = ids.filter((id) => publishedIds.has(id)).length;
if (ranPublished >= 4) {
  if (goldExact === 4) pass("gold_exact", "4/4");
  else fail("gold_exact", `${goldExact}/4`);
} else if (goldExact >= 3) pass("gold_progress", `${goldExact}/4`);
else if (ranPublished > 0) fail("gold_progress", `${goldExact}/4`);

const ranHot = ids.some((id) => (sample.hot || []).some((h) => h.id === id));
if (ranHot) {
  if (hotComplete >= 1) pass("hot_complete_ge1", String(hotComplete));
  else fail("hot_complete_ge1", "0 — see frontier blockers per candidate");
}

report.endedAt = new Date().toISOString();
report.gatePass = report.failures.length === 0;
report.hotComplete = hotComplete;
report.goldExact = goldExact;
fs.writeFileSync(path.join(OUT, "analyzelead-acceptance.json"), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    { gatePass: report.gatePass, failures: report.failures, goldExact, hotComplete },
    null,
    2
  )
);
await prisma.$disconnect().catch(() => {});
process.exit(report.gatePass ? 0 : 1);
