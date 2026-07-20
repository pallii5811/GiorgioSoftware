/**
 * Production Sanità revalidation v2 — shadow DB only, resumable, analyzeLead-only.
 * NEVER uses SCAN_FAST. NEVER applies to live (see production-apply-revalidation.mjs).
 *
 * Env:
 *   DATABASE_URL (required, shadow)
 *   FRONTIER_DB_PATH base (per-lead frontier under data/revalidation/frontiers/)
 *   REVALIDATE_CHECKPOINT (default data/revalidation/checkpoint.json)
 *   REVALIDATE_CONCURRENCY (default 2, max 4)
 *   REVALIDATE_REGION (optional Campania|Veneto)
 *   REVALIDATE_LIMIT (optional)
 *   REVALIDATE_IDS (optional comma ids)
 *   REVALIDATE_DUAL_HOT=1 for second independent pass on HOT candidates
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const ROOT = path.resolve(".");
const OUT_DIR = path.join(ROOT, "data/revalidation");
const RESULTS_DIR = path.join(OUT_DIR, "results");
const FRONTIER_DIR = path.join(OUT_DIR, "frontiers");
const CHECKPOINT =
  process.env.REVALIDATE_CHECKPOINT || path.join(OUT_DIR, "checkpoint.json");

fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.mkdirSync(FRONTIER_DIR, { recursive: true });

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL required (shadow)");
  process.exit(2);
}
if (/168\.119\.253\.47|\/opt\/leadsniper\/prisma\/dev\.db/i.test(process.env.DATABASE_URL) && process.env.ALLOW_LIVE_REVALIDATE !== "1") {
  console.error("Refusing live DB path without ALLOW_LIVE_REVALIDATE=1");
  process.exit(2);
}

process.env.STAGING_MODE = process.env.STAGING_MODE ?? "true";
process.env.DISABLE_LIVE_DB = "true";
process.env.DISABLE_EMAILS = "true";
process.env.SCAN_ENGINE_LOCAL = "1";
process.env.OCR_ENABLED = process.env.OCR_ENABLED ?? "1";
process.env.POLICY_EXHAUSTIVE = "1";
process.env.SCAN_FAST = "0";
delete process.env.SCAN_FAST;

const concurrency = Math.min(
  4,
  Math.max(1, Number(process.env.REVALIDATE_CONCURRENCY || 2))
);
const dualHot = process.env.REVALIDATE_DUAL_HOT === "1";
const limit = process.env.REVALIDATE_LIMIT ? Number(process.env.REVALIDATE_LIMIT) : null;
const onlyIds = process.env.REVALIDATE_IDS
  ? new Set(process.env.REVALIDATE_IDS.split(",").map((s) => s.trim()).filter(Boolean))
  : null;
const regionFilter = process.env.REVALIDATE_REGION || null;

let testedCodeSha = null;
try {
  testedCodeSha = execSync("git rev-parse HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
} catch {
  testedCodeSha = process.env.GIT_HEAD || null;
}

const { prisma } = await import("../src/lib/prisma.ts");
const { analyzeLead } = await import("../src/lib/sanita/scan-engine.ts");
const { readVerdictToken } = await import("../src/lib/sanita/verdict.ts");
const { readProcessingState, readBusinessVerdict, readValidationStatus } = await import(
  "../src/lib/sanita/processing-state.ts"
);
const { openFrontierStore } = await import("../src/lib/sanita/frontier-store.ts");

function loadCheckpoint() {
  if (!fs.existsSync(CHECKPOINT)) {
    return {
      version: 2,
      testedCodeSha,
      startedAt: new Date().toISOString(),
      done: {},
      order: [],
      stats: { processed: 0, hot: 0, pub: 0, review: 0, retry: 0, tech: 0, errors: 0 },
    };
  }
  return JSON.parse(fs.readFileSync(CHECKPOINT, "utf8"));
}

function saveCheckpoint(cp) {
  cp.updatedAt = new Date().toISOString();
  cp.testedCodeSha = testedCodeSha;
  const tmp = CHECKPOINT + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cp, null, 2));
  fs.renameSync(tmp, CHECKPOINT);
}

let stopping = false;
function onStop() {
  stopping = true;
  console.error(JSON.stringify({ event: "shutdown_requested" }));
}
process.on("SIGINT", onStop);
process.on("SIGTERM", onStop);

function priorityBucket(evidence) {
  const t = readVerdictToken(evidence || "") || "";
  if (t === "HOT") return 0;
  if (t === "PUBLISHED") return 1;
  if (t === "REVIEW") return 2;
  return 3;
}

function emptyCounters() {
  return {
    analyzed: 0,
    withPolicy: 0,
    published: 0,
    hot: 0,
    review: 0,
    reviewHuman: 0,
    retryPending: 0,
    technicalBlocked: 0,
    outOfScope: 0,
    regionalChecked: 0,
    regionalWithPolicy: 0,
  };
}

async function runOnePass(lead, passLabel) {
  const runId = `reval-${passLabel}-${lead.id}-${Date.now()}`;
  const frontierPath = path.join(FRONTIER_DIR, `${runId}.sqlite`);
  process.env.SHADOW_RUN_ID = runId;
  process.env.FRONTIER_DB_PATH = frontierPath;
  openFrontierStore(frontierPath);
  const counters = emptyCounters();
  const t0 = Date.now();
  let error = null;
  try {
    await analyzeLead(
      {
        id: lead.id,
        osmId: lead.osmId,
        category: lead.category,
        companyName: lead.companyName,
        city: lead.city,
        region: lead.region,
        website: lead.website,
        phone: lead.phone,
        email: lead.email,
        pec: lead.pec,
        piva: lead.piva,
      },
      counters
    );
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const after = await prisma.lead.findUnique({ where: { id: lead.id } });
  const evidence = after?.evidence || "";
  return {
    runId,
    frontierPath,
    wallMs: Date.now() - t0,
    error,
    token: readVerdictToken(evidence),
    processingState: readProcessingState(evidence),
    businessVerdict: readBusinessVerdict(evidence),
    validationStatus: readValidationStatus(evidence),
    crawlComplete: /\[CRAWL_COMPLETE:true\]/i.test(evidence),
    evidenceSnippet: evidence.slice(0, 800),
    policyFound: after?.policyFound ?? null,
    policyCompany: after?.policyCompany ?? null,
    policyExpiry: after?.policyExpiry ?? null,
    counters,
    website: after?.website ?? lead.website,
  };
}

function dualAgree(a, b) {
  if (!a || !b || a.error || b.error) return false;
  if (a.token !== "HOT" || b.token !== "HOT") return false;
  if (!a.crawlComplete || !b.crawlComplete) return false;
  if (a.policyFound || b.policyFound) return false;
  if (a.processingState !== "HOT_VERIFIED" || b.processingState !== "HOT_VERIFIED") return false;
  return true;
}

const cp = loadCheckpoint();
const where = {
  type: "HEALTHCARE",
  ...(regionFilter ? { region: regionFilter } : { region: { in: ["Campania", "Veneto"] } }),
  ...(onlyIds ? { id: { in: [...onlyIds] } } : {}),
};

const leads = await prisma.lead.findMany({
  where,
  select: {
    id: true,
    osmId: true,
    category: true,
    companyName: true,
    city: true,
    region: true,
    website: true,
    phone: true,
    email: true,
    pec: true,
    piva: true,
    evidence: true,
    status: true,
    notes: true,
    lastScannedAt: true,
  },
});

leads.sort((a, b) => {
  const pa = priorityBucket(a.evidence);
  const pb = priorityBucket(b.evidence);
  if (pa !== pb) return pa - pb;
  return String(a.id).localeCompare(String(b.id));
});

let queue = leads.filter((l) => !cp.done[l.id]);
if (limit != null && Number.isFinite(limit)) queue = queue.slice(0, limit);

console.log(
  JSON.stringify({
    event: "revalidate_start",
    testedCodeSha,
    totalCandidates: leads.length,
    remaining: queue.length,
    concurrency,
    dualHot,
    checkpoint: CHECKPOINT,
  })
);

async function processLead(lead) {
  if (stopping) return;
  const oldEvidence = lead.evidence || "";
  const oldToken = readVerdictToken(oldEvidence);
  const pass1 = await runOnePass(lead, "p1");
  let pass2 = null;
  let final = pass1;
  let dualDisagreement = false;

  if (dualHot && !pass1.error && pass1.token === "HOT" && pass1.crawlComplete) {
    pass2 = await runOnePass(lead, "p2");
    if (!dualAgree(pass1, pass2)) {
      dualDisagreement = true;
      final = {
        ...pass2,
        token: "REVIEW",
        processingState: "REVIEW_HUMAN",
        businessVerdict: "REVIEW_HUMAN",
        validationStatus: "CONFLICT_FOUND",
        evidenceSnippet: `DUAL_HOT_DISAGREE p1=${pass1.token}/${pass1.processingState} p2=${pass2.token}/${pass2.processingState}. ${pass2.evidenceSnippet || ""}`,
      };
    }
  }

  const row = {
    id: lead.id,
    companyName: lead.companyName,
    region: lead.region,
    city: lead.city,
    crmStatus: lead.status,
    notes: lead.notes,
    oldVerdict: oldToken,
    newVerdict: final.token,
    oldEvidenceSnippet: oldEvidence.slice(0, 400),
    newEvidenceSnippet: final.evidenceSnippet,
    processingState: final.processingState,
    businessVerdict: final.businessVerdict,
    validationStatus: final.validationStatus,
    crawlComplete: final.crawlComplete,
    policyFound: final.policyFound,
    contacts: { phone: lead.phone, email: lead.email, pec: lead.pec, website: final.website },
    pass1,
    pass2,
    dualDisagreement,
    testedCodeSha,
    finishedAt: new Date().toISOString(),
    reasonCode: dualDisagreement
      ? "DUAL_HOT_DISAGREE"
      : final.error
        ? "ANALYZE_ERROR"
        : final.processingState || final.token,
  };

  fs.writeFileSync(path.join(RESULTS_DIR, `${lead.id}.json`), JSON.stringify(row, null, 2));
  cp.done[lead.id] = {
    finishedAt: row.finishedAt,
    newVerdict: row.newVerdict,
    processingState: row.processingState,
    reasonCode: row.reasonCode,
  };
  cp.order.push(lead.id);
  cp.stats.processed++;
  if (row.newVerdict === "HOT") cp.stats.hot++;
  else if (row.newVerdict === "PUBLISHED") cp.stats.pub++;
  else if (row.processingState === "RETRY_PENDING") cp.stats.retry++;
  else if (row.processingState === "TECHNICAL_BLOCKED") cp.stats.tech++;
  else cp.stats.review++;
  if (final.error) cp.stats.errors++;
  saveCheckpoint(cp);

  console.log(
    JSON.stringify({
      event: "lead_done",
      id: lead.id,
      companyName: lead.companyName,
      oldVerdict: oldToken,
      newVerdict: row.newVerdict,
      processingState: row.processingState,
      dualDisagreement,
      wallMs: (pass1.wallMs || 0) + (pass2?.wallMs || 0),
      remaining: Object.keys(cp.done).length,
      total: leads.length,
    })
  );
}

let idx = 0;
async function worker() {
  while (!stopping) {
    const i = idx++;
    if (i >= queue.length) break;
    await processLead(queue[i]);
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
saveCheckpoint(cp);
await prisma.$disconnect().catch(() => {});

const remaining = leads.length - Object.keys(cp.done).length;
console.log(
  JSON.stringify({
    event: "revalidate_end",
    stopping,
    processed: cp.stats.processed,
    remaining,
    stats: cp.stats,
    complete: remaining === 0 && !stopping,
  })
);
process.exit(stopping ? 130 : remaining === 0 ? 0 : 1);
