/**
 * Heidy-only HOT acceptance — isolated DB + frontier, fresh CrawlRun.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(".");
const OUT = path.join(ROOT, "docs/staging-acceptance");
const SRC_DB = path.join(ROOT, "data/staging/db/giorgio-staging-recovery-20260719.db");
const DST_DB = path.join(ROOT, "data/staging/db/giorgio-heidy-lastmile.db");
const HEIDY_ID = "cmqo8aopr002waa3v4cgcbhpv";
const RUN_ID = `heidy-lastmile-${Date.now()}`;
const FRONTIER = path.join(ROOT, `data/staging/frontier/heidy-lastmile-${RUN_ID}.sqlite`);

fs.mkdirSync(path.dirname(DST_DB), { recursive: true });
fs.mkdirSync(path.dirname(FRONTIER), { recursive: true });
fs.copyFileSync(SRC_DB, DST_DB);

process.env.STAGING_MODE = "true";
process.env.DISABLE_LIVE_DB = "true";
process.env.DISABLE_EMAILS = "true";
process.env.DATABASE_URL = `file:${DST_DB.replace(/\\/g, "/")}`;
process.env.FRONTIER_DB_PATH = FRONTIER;
process.env.SHADOW_RUN_ID = RUN_ID;
process.env.OCR_ENABLED = process.env.OCR_ENABLED ?? "1";

const stagingPpm = path.join(
  ROOT,
  "data/staging/poppler/poppler-24.08.0/Library/bin/pdftoppm.exe"
);
if (!process.env.PDFTOPPM_PATH && fs.existsSync(stagingPpm)) {
  process.env.PDFTOPPM_PATH = stagingPpm;
}

const { execSync } = await import("node:child_process");
let gitHead = null;
try {
  gitHead = execSync("git rev-parse HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
} catch {
  /* */
}

const { prisma } = await import("../src/lib/prisma.ts");
const { analyzeLead } = await import("../src/lib/sanita/scan-engine.ts");
const { readVerdictToken } = await import("../src/lib/sanita/verdict.ts");
const { readProcessingState, readBusinessVerdict, readValidationStatus } = await import(
  "../src/lib/sanita/processing-state.ts"
);
const { openFrontierStore, deriveCrawlCompleteness } = await import("../src/lib/sanita/frontier-store.ts");
const { sitemapStatusAllowsHot } = await import("../src/lib/evidence/contract.ts");
const { presentSanitaLead } = await import("../src/lib/sanita/present-sanita-lead.ts");

openFrontierStore(FRONTIER);

function readRun(leadId) {
  if (!fs.existsSync(FRONTIER)) return null;
  const db = new DatabaseSync(FRONTIER, { readOnly: true });
  const run = db
    .prepare(`SELECT * FROM CrawlRun WHERE leadId = ? ORDER BY startedAt DESC LIMIT 1`)
    .get(leadId);
  const nodes = run
    ? db
        .prepare(
          `SELECT canonicalUrl, state, relevance, resourceType, discoverySource, lastError FROM CrawlFrontierNode WHERE crawlRunId = ?`
        )
        .all(run.id)
    : [];
  db.close();
  if (!run) return null;
  const completeness = deriveCrawlCompleteness(run.id);
  return {
    crawlRunId: run.id,
    runId: RUN_ID,
    sitemapStatus: run.sitemapStatus,
    identityVerified: !!run.identityVerified,
    scopeVerified: !!run.scopeVerified,
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
    xhrJson: nodes.filter(
      (n) => /xhr|json/i.test(n.discoverySource || "") || /\.json/i.test(n.canonicalUrl || "")
    ).length,
    playwrightSources: nodes.filter((n) => /playwright/i.test(n.discoverySource || "")).length,
    firstPartyUrls: nodes
      .filter((n) => n.state === "COMPLETED" || n.state === "EXCLUDED")
      .map((n) => n.canonicalUrl)
      .slice(0, 40),
  };
}

const before = await prisma.lead.findUnique({ where: { id: HEIDY_ID } });
if (!before) {
  console.error("Heidy missing in staging DB");
  process.exit(1);
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

console.log(`>>> Heidy-only analyzeLead runId=${RUN_ID}`);
const t0 = Date.now();
let error = null;
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
  error = e instanceof Error ? e.message : String(e);
}

const after = await prisma.lead.findUnique({ where: { id: HEIDY_ID } });
const evidence = after?.evidence || "";
const token = readVerdictToken(evidence);
const state = readProcessingState(evidence);
const bv = readBusinessVerdict(evidence);
const vs = readValidationStatus(evidence);
const frontier = readRun(HEIDY_ID);
const semantic = presentSanitaLead(after || before);

const gates = {
  sitemap_terminal: sitemapStatusAllowsHot(frontier?.sitemapStatus ?? "NOT_DISCOVERED"),
  identity_official: /\[IDENTITY:OFFICIAL_CONFIRMED\]/i.test(evidence),
  scope_verified: frontier?.scopeVerified === true,
  pending_zero: (frontier?.pending ?? 99) === 0,
  retry_zero: (frontier?.retry ?? 99) === 0,
  failed_zero: (frontier?.failed ?? 99) === 0,
  ocr_doubts_zero: (frontier?.ocrDoubts ?? 99) === 0,
  policy_candidates_zero: (frontier?.unresolvedPolicyCandidates ?? 99) === 0,
  url_cap_false: frontier?.urlCapReached === false,
  time_cap_false: frontier?.timeCapReached === false,
  final_complete: frontier?.complete === true && /\[CRAWL_COMPLETE:true\]/i.test(evidence),
  policy_found_false: !after?.policyFound,
  verdict_hot: token === "HOT",
  business_hot_verified: bv === "HOT_VERIFIED",
  processing_hot_verified: state === "HOT_VERIFIED",
  validation_current: vs === "CURRENT_VERIFIED",
  counter_hot_one: counters.hot === 1,
  counter_review_zero: counters.reviewHuman === 0,
  counter_retry_zero: counters.retryPending === 0,
  semantic_crawl_complete: semantic.crawlComplete === true,
  regional_hint_not_blocking:
    !/REVIEW_HUMAN/i.test(state || "") &&
    (/portale regionale|Portali ASL/i.test(evidence) || !/polizza rilevata/i.test(evidence)),
};

const failures = Object.entries(gates)
  .filter(([, v]) => !v)
  .map(([k]) => k);

const report = {
  testedCodeSha: gitHead,
  runId: RUN_ID,
  db: DST_DB,
  frontier: FRONTIER,
  startedAt: new Date(t0).toISOString(),
  endedAt: new Date().toISOString(),
  wallMs: Date.now() - t0,
  error,
  lead: {
    id: HEIDY_ID,
    companyName: after?.companyName,
    website: after?.website,
    token,
    businessVerdict: bv,
    processingState: state,
    validationStatus: vs,
    policyFound: after?.policyFound,
    crawlComplete: semantic.crawlComplete,
    evidenceSnippet: evidence.slice(0, 1200),
    frontier,
    counters,
    semantic: {
      clientLabel: semantic.clientLabel,
      clientExplanation: semantic.clientExplanation,
      actionable: semantic.actionable,
      queueStatus: semantic.queueStatus,
    },
  },
  gates,
  failures,
  gatePass: failures.length === 0 && !error,
};

const outPath = path.join(OUT, "heidy-lastmile-acceptance.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ gatePass: report.gatePass, failures, token, state, bv, counters }, null, 2));
await prisma.$disconnect().catch(() => {});
process.exit(report.gatePass ? 0 : 1);
