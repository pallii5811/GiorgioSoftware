/**
 * HOT acceptance — real analyzeLead on 4 staging candidates.
 * Does NOT overwrite analyzelead-acceptance.json (published gold).
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(".");
const OUT = path.join(ROOT, "docs/staging-acceptance");
const SAMPLE = path.join(OUT, "sample-sanita.json");
const SRC_DB = path.join(ROOT, "data/staging/db/giorgio-staging-recovery-20260719.db");
const DST_DB = path.join(ROOT, "data/staging/db/giorgio-hot-acceptance.db");
const FRONTIER = path.join(ROOT, "data/staging/frontier/hot-acceptance.sqlite");

const HOT_IDS = [
  "cmqo8aopr002waa3v4cgcbhpv",
  "cmqn3iyi200041272wj07lzg8",
  "cmqpfl9lv00bk109jnimvoitz",
  "cmqots2uz007paa3vdko4kxvu",
];

fs.mkdirSync(path.dirname(DST_DB), { recursive: true });
fs.copyFileSync(SRC_DB, DST_DB);
if (fs.existsSync(FRONTIER)) fs.unlinkSync(FRONTIER);

process.env.STAGING_MODE = "true";
process.env.DISABLE_LIVE_DB = "true";
process.env.DISABLE_EMAILS = "true";
process.env.DATABASE_URL = `file:${DST_DB.replace(/\\/g, "/")}`;
process.env.FRONTIER_DB_PATH = FRONTIER;
process.env.SHADOW_RUN_ID = "hot-acceptance";
process.env.OCR_ENABLED = process.env.OCR_ENABLED ?? "1";

const stagingPpm = path.join(
  ROOT,
  "data/staging/poppler/poppler-24.08.0/Library/bin/pdftoppm.exe"
);
if (!process.env.PDFTOPPM_PATH && fs.existsSync(stagingPpm)) {
  process.env.PDFTOPPM_PATH = stagingPpm;
}

const { prisma } = await import("../src/lib/prisma.ts");
const { analyzeLead } = await import("../src/lib/sanita/scan-engine.ts");
const { readVerdictToken } = await import("../src/lib/sanita/verdict.ts");
const { readProcessingState, readBusinessVerdict, readValidationStatus } = await import(
  "../src/lib/sanita/processing-state.ts"
);
const { openFrontierStore, deriveCrawlCompleteness } = await import("../src/lib/sanita/frontier-store.ts");

openFrontierStore(FRONTIER);

function readRun(leadId) {
  if (!fs.existsSync(FRONTIER)) return null;
  const db = new DatabaseSync(FRONTIER, { readOnly: true });
  const run = db
    .prepare(`SELECT * FROM CrawlRun WHERE leadId = ? ORDER BY startedAt DESC LIMIT 1`)
    .get(leadId);
  const nodes = run
    ? db
        .prepare(`SELECT state, relevance, resourceType, discoverySource, lastError FROM CrawlFrontierNode WHERE crawlRunId = ?`)
        .all(run.id)
    : [];
  db.close();
  if (!run) return null;
  const completeness = deriveCrawlCompleteness(run.id);
  return {
    crawlRunId: run.id,
    sitemapStatus: run.sitemapStatus,
    identityVerified: !!run.identityVerified,
    scopeVerified: !!run.scopeVerified,
    htmlQueueExhausted: completeness.htmlQueueExhausted,
    relevantLinksProcessed: completeness.relevantLinksProcessed,
    relevantDocumentsProcessed: completeness.relevantDocumentsProcessed,
    jsonEndpointsProcessed: completeness.jsonEndpointsProcessed,
    sameHostScriptsProcessed: completeness.sameHostScriptsProcessed,
    pending: nodes.filter((n) =>
      ["DISCOVERED", "QUEUED", "FETCHING", "FETCHED", "RENDERED", "PARSED"].includes(n.state)
    ).length,
    retry: nodes.filter((n) => n.state === "RETRY_PENDING").length,
    failed: nodes.filter((n) => n.state === "TECHNICAL_BLOCKED").length,
    ocrDoubts: Number(run.ocrDoubts || 0),
    unresolvedPolicyCandidates: Number(run.unresolvedPolicyCandidates || 0),
    complete: completeness.complete,
    completenessReasons: completeness.reasons || [],
    urlCapReached: !!run.urlCapReached,
    timeCapReached: !!run.timeCapReached,
    nodeCount: nodes.length,
    playwrightSources: nodes.filter((n) => /playwright/i.test(n.discoverySource || "")).length,
    xhrJson: nodes.filter(
      (n) => /xhr|json/i.test(n.discoverySource || "") || /\.json/i.test(n.canonicalUrl || "")
    ).length,
  };
}

const sample = JSON.parse(fs.readFileSync(SAMPLE, "utf8"));
const report = {
  head: process.env.GIT_HEAD || null,
  startedAt: new Date().toISOString(),
  ids: HOT_IDS,
  results: [],
  gates: {},
  failures: [],
};

let falseHot = 0;
let hotIncomplete = 0;
let hotComplete = 0;
let techAsHuman = 0;

for (const id of HOT_IDS) {
  const meta = (sample.hot || []).find((h) => h.id === id);
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
  console.log(`\n>>> HOT analyzeLead ${before.companyName} (${id})`);
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
  const frontier = readRun(id);
  const row = {
    id,
    companyName: after?.companyName || meta?.companyName,
    website: after?.website,
    token,
    businessVerdict: bv,
    validationStatus: vs,
    processingState: state,
    policyCompany: after?.policyCompany,
    policyNumber: after?.policyNumber,
    policyExpiry: after?.policyExpiry,
    evidenceSnippet: evidence.slice(0, 600),
    crawlComplete: /\[CRAWL_COMPLETE:true\]/i.test(evidence),
    frontier,
    counters,
    wallMs: Date.now() - t0,
  };
  report.results.push(row);

  if (token === "HOT" && /\[CRAWL_COMPLETE:false\]/i.test(evidence)) falseHot++;
  if (token === "HOT" && frontier?.complete) hotComplete++;
  if (token === "HOT" && !frontier?.complete) hotIncomplete++;
  if (state === "RETRY_PENDING" && token === "REVIEW") techAsHuman++;
  if (token === "HOT" && state === "REVIEW_HUMAN") techAsHuman++;

  console.log(
    `OK ${row.companyName} → ${token}/${bv}/${state} complete=${frontier?.complete} sitemap=${frontier?.sitemapStatus} ${row.wallMs}ms`
  );
}

if (falseHot === 0) report.gates.false_hot = true;
else report.failures.push({ gate: "false_hot", msg: String(falseHot) });
if (hotIncomplete === 0) report.gates.hot_incomplete = true;
else report.failures.push({ gate: "hot_incomplete", msg: String(hotIncomplete) });
if (hotComplete >= 1) report.gates.hot_complete_ge1 = true;
else report.failures.push({ gate: "hot_complete_ge1", msg: "0" });
if (techAsHuman === 0) report.gates.tech_as_human = true;
else report.failures.push({ gate: "tech_as_human", msg: String(techAsHuman) });

report.endedAt = new Date().toISOString();
report.gatePass = report.failures.length === 0;
report.hotComplete = hotComplete;
report.falseHot = falseHot;
report.hotIncomplete = hotIncomplete;

const outPath = path.join(OUT, "hot-analyzelead-acceptance.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ gatePass: report.gatePass, failures: report.failures, hotComplete }, null, 2));
await prisma.$disconnect().catch(() => {});
process.exit(report.gatePass ? 0 : 1);
