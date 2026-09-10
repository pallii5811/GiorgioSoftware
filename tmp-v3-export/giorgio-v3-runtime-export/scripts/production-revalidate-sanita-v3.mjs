/**
 * Production Sanità revalidation v3 — parent scheduler only.
 * Spawns isolated worker processes. Never imports analyzeLead / openFrontierStore.
 *
 * Migrates v2 checkpoint (RETRY_PENDING → retryQueue). Resumes without wiping.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";
import {
  emptyCheckpointV3,
  migrateCheckpointV2toV3,
  saveCheckpointAtomic,
  classifyResult,
  nextRetryAt,
  MAX_RETRY_ATTEMPTS,
  isTerminalState,
  writeResultAtomic,
} from "./revalidate-checkpoint-v3.mjs";

const ROOT = path.resolve(".");
const OUT_DIR = path.join(ROOT, "data/revalidation");
const RESULTS_DIR = path.join(OUT_DIR, "results");
const FRONTIER_DIR = path.join(OUT_DIR, "frontiers");
const LOCK_DIR = path.join(OUT_DIR, "locks");
const CHECKPOINT =
  process.env.REVALIDATE_CHECKPOINT || path.join(OUT_DIR, "checkpoint.json");
const WORKER = path.join(ROOT, "scripts/production-revalidate-sanita-worker.mjs");

fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.mkdirSync(FRONTIER_DIR, { recursive: true });
fs.mkdirSync(LOCK_DIR, { recursive: true });

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL required (shadow)");
  process.exit(2);
}
if (/\/opt\/leadsniper\/prisma\/dev\.db/i.test(process.env.DATABASE_URL) && process.env.ALLOW_LIVE_REVALIDATE !== "1") {
  console.error("Refusing live DB");
  process.exit(2);
}

const dualHot = process.env.REVALIDATE_DUAL_HOT === "1";
const regionFilter = process.env.REVALIDATE_REGION || null;
const limit = process.env.REVALIDATE_LIMIT ? Number(process.env.REVALIDATE_LIMIT) : null;
const onlyIds = process.env.REVALIDATE_IDS
  ? new Set(process.env.REVALIDATE_IDS.split(",").map((s) => s.trim()).filter(Boolean))
  : null;

function resolveSha() {
  const env = (process.env.GIT_HEAD || process.env.RELEASE_SHA || "").trim();
  if (/^[0-9a-f]{40}$/i.test(env)) return env.toLowerCase();
  for (const p of [path.join(ROOT, "RELEASE_SHA"), "/opt/leadsniper/RELEASE_SHA"]) {
    try {
      const v = fs.readFileSync(p, "utf8").trim();
      if (/^[0-9a-f]{40}$/i.test(v)) return v.toLowerCase();
    } catch {
      /* */
    }
  }
  return null;
}
const testedCodeSha = resolveSha();

let rawCp = fs.existsSync(CHECKPOINT)
  ? JSON.parse(fs.readFileSync(CHECKPOINT, "utf8"))
  : emptyCheckpointV3(testedCodeSha);

const mig = migrateCheckpointV2toV3(rawCp, RESULTS_DIR, testedCodeSha);
const cp = mig.checkpoint;
cp.testedCodeSha = testedCodeSha || cp.testedCodeSha;
saveCheckpointAtomic(CHECKPOINT, cp);
console.log(
  JSON.stringify({
    event: "checkpoint_migrated",
    migratedRetry: mig.migrated,
    terminal: mig.terminal,
    retry: mig.retry,
    version: cp.version,
  })
);

// Clear stale inProgress from crash
for (const id of Object.keys(cp.inProgress || {})) {
  if (!cp.retryQueue[id] && !cp.terminal[id]) {
    cp.retryQueue[id] = {
      attempts: cp.attempts[id] || 1,
      lastReason: "IN_PROGRESS_INTERRUPTED",
      lastError: "parent_restart",
      nextRetryAt: new Date(0).toISOString(),
      lastRunId: cp.inProgress[id]?.runId || null,
      frontierPath: cp.inProgress[id]?.frontierPath || null,
      firstSeenAt: cp.inProgress[id]?.startedAt || new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(),
    };
  }
  delete cp.inProgress[id];
}
saveCheckpointAtomic(CHECKPOINT, cp);

const { prisma } = await import("../src/lib/prisma.ts");
const { readVerdictToken } = await import("../src/lib/sanita/verdict.ts");

const where = {
  type: "HEALTHCARE",
  ...(regionFilter ? { region: regionFilter } : { region: { in: ["Campania", "Veneto"] } }),
  ...(onlyIds ? { id: { in: [...onlyIds] } } : {}),
};
const leads = await prisma.lead.findMany({
  where,
  select: {
    id: true,
    companyName: true,
    city: true,
    region: true,
    evidence: true,
    category: true,
  },
});

function priorityBucket(evidence) {
  const t = readVerdictToken(evidence || "") || "";
  if (t === "HOT") return 0;
  if (t === "PUBLISHED") return 1;
  if (t === "REVIEW") return 2;
  return 3;
}
leads.sort((a, b) => {
  const pa = priorityBucket(a.evidence);
  const pb = priorityBucket(b.evidence);
  if (pa !== pb) return pa - pb;
  return String(a.id).localeCompare(String(b.id));
});

function dueRetryIds() {
  const now = Date.now();
  return Object.entries(cp.retryQueue)
    .filter(([, meta]) => new Date(meta.nextRetryAt || 0).getTime() <= now)
    .map(([id]) => id);
}

function pendingNewIds() {
  return leads
    .map((l) => l.id)
    .filter((id) => !cp.terminal[id] && !cp.retryQueue[id] && !cp.inProgress[id]);
}

let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
  console.error(JSON.stringify({ event: "shutdown_requested" }));
});
process.on("SIGTERM", () => {
  stopping = true;
  console.error(JSON.stringify({ event: "shutdown_requested" }));
});

function acquireLeadLock(id) {
  const lockPath = path.join(LOCK_DIR, `${id}.lock`);
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
    return lockPath;
  } catch {
    return null;
  }
}
function releaseLeadLock(lockPath) {
  try {
    if (lockPath && fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  } catch {
    /* */
  }
}

function adaptiveConcurrency(current) {
  const freeMemMb = os.freemem() / (1024 * 1024);
  const load = os.loadavg()[0] || 0;
  const cpus = os.cpus().length || 2;
  if (freeMemMb < 800 || load > cpus * 0.9) return 1;
  if (freeMemMb > 2000 && load < cpus * 0.55 && current >= 2) return 3;
  return Math.max(1, Math.min(2, current || 2));
}

function spawnWorker({ leadId, passLabel, outPath, frontierPath, runId }) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      REVALIDATE_LEAD_ID: leadId,
      REVALIDATE_PASS: passLabel,
      REVALIDATE_OUT: outPath,
      FRONTIER_DB_PATH: frontierPath,
      SHADOW_RUN_ID: runId,
      GIT_HEAD: testedCodeSha || "",
      RELEASE_SHA: testedCodeSha || "",
      SCAN_ENGINE_LOCAL: "1",
      OCR_ENABLED: process.env.OCR_ENABLED || "1",
      POLICY_EXHAUSTIVE: "1",
      SCAN_FAST: "0",
      STAGING_MODE: "true",
      DISABLE_LIVE_DB: "true",
      DISABLE_EMAILS: "true",
    };
    const child = spawn("npx", ["tsx", WORKER], {
      env,
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
      process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      process.stderr.write(d);
    });
    child.on("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
    child.on("error", (err) => {
      resolve({ code: 99, signal: null, stdout, stderr: String(err) });
    });
  });
}

function mergePassIntoResult(basePath, passLabel, passRow) {
  let base = fs.existsSync(basePath) ? JSON.parse(fs.readFileSync(basePath, "utf8")) : passRow;
  if (passLabel === "p1") {
    base = { ...passRow, pass1: passRow.pass1 || passRow.pass1 };
  } else if (passLabel === "p2") {
    base.pass2 = passRow.pass2 || {
      runId: passRow.runIds?.[0],
      frontierPath: passRow.frontierPaths?.[0],
      wallMs: passRow.wallMs,
      error: passRow.error,
      token: passRow.token,
      processingState: passRow.processingState,
      crawlComplete: passRow.crawlComplete,
      policyFound: passRow.policyFound,
    };
    base.runIds = [...(base.runIds || []), ...(passRow.runIds || [])];
    base.frontierPaths = [...(base.frontierPaths || []), ...(passRow.frontierPaths || [])];
    // dual agreement
    const a = base.pass1;
    const b = base.pass2;
    const agree =
      a &&
      b &&
      !a.error &&
      !b.error &&
      a.token === "HOT" &&
      b.token === "HOT" &&
      a.crawlComplete &&
      b.crawlComplete &&
      !a.policyFound &&
      !b.policyFound &&
      a.processingState === "HOT_VERIFIED" &&
      b.processingState === "HOT_VERIFIED";
    if (!agree) {
      base.dualDisagreement = true;
      base.processingState = "REVIEW_HUMAN";
      base.businessVerdict = "REVIEW_HUMAN";
      base.validationStatus = "CONFLICT_FOUND";
      base.newVerdict = "REVIEW";
      base.reasonCode = "DUAL_HOT_DISAGREE";
      base.terminal = true;
    } else {
      base.dualDisagreement = false;
      base.processingState = "HOT_VERIFIED";
      base.businessVerdict = "HOT_VERIFIED";
      base.fullEvidence = passRow.fullEvidence || base.fullEvidence;
      base.terminal = true;
    }
  }
  writeResultAtomic(basePath, base);
  return base;
}

async function processLeadId(leadId) {
  if (stopping) return;
  if (cp.terminal[leadId]) return;
  const lock = acquireLeadLock(leadId);
  if (!lock) {
    console.log(JSON.stringify({ event: "lock_busy", id: leadId }));
    return;
  }
  const runId = `reval-p1-${leadId}-${Date.now()}`;
  const frontierPath = path.join(FRONTIER_DIR, `${runId}.sqlite`);
  const outPath = path.join(RESULTS_DIR, `${leadId}.json`);
  const tmpOut = path.join(RESULTS_DIR, `${leadId}.p1.json`);

  cp.inProgress[leadId] = { startedAt: new Date().toISOString(), runId, frontierPath, pass: "p1" };
  cp.attempts[leadId] = (cp.attempts[leadId] || 0) + 1;
  saveCheckpointAtomic(CHECKPOINT, cp);

  try {
    const r1 = await spawnWorker({
      leadId,
      passLabel: "p1",
      outPath: tmpOut,
      frontierPath,
      runId,
    });
    if (!fs.existsSync(tmpOut)) {
      throw new Error(`worker_no_output code=${r1.code}`);
    }
    const pass1 = JSON.parse(fs.readFileSync(tmpOut, "utf8"));
    let finalRow = { ...pass1, pass1: pass1.pass1 || pass1 };

    // Fail-closed: any HOT complete candidate MUST get dual pass when enabled.
    // Treat null/undefined policyFound as "not found" (only true blocks dual).
    const needsDual =
      dualHot &&
      !pass1.error &&
      pass1.token === "HOT" &&
      pass1.crawlComplete === true &&
      (pass1.processingState === "HOT_VERIFIED" || pass1.businessVerdict === "HOT_VERIFIED") &&
      pass1.policyFound !== true;

    if (needsDual) {
      if (stopping) {
        // Fail-closed: never promote HOT without dual pass
        finalRow = {
          ...finalRow,
          token: null,
          newVerdict: null,
          processingState: "RETRY_PENDING",
          businessVerdict: null,
          validationStatus: "REVALIDATION_PENDING",
          dualDisagreement: false,
          terminal: false,
          reasonCode: "DUAL_HOT_DEFERRED_SHUTDOWN",
        };
        writeResultAtomic(outPath, finalRow);
      } else {
        const runId2 = `reval-p2-${leadId}-${Date.now()}`;
        const frontier2 = path.join(FRONTIER_DIR, `${runId2}.sqlite`);
        const tmp2 = path.join(RESULTS_DIR, `${leadId}.p2.json`);
        cp.inProgress[leadId] = {
          startedAt: new Date().toISOString(),
          runId: runId2,
          frontierPath: frontier2,
          pass: "p2",
        };
        saveCheckpointAtomic(CHECKPOINT, cp);
        const r2 = await spawnWorker({
          leadId,
          passLabel: "p2",
          outPath: tmp2,
          frontierPath: frontier2,
          runId: runId2,
        });
        if (!fs.existsSync(tmp2)) {
          finalRow = {
            ...finalRow,
            token: null,
            newVerdict: null,
            processingState: "RETRY_PENDING",
            businessVerdict: null,
            validationStatus: "REVALIDATION_PENDING",
            dualDisagreement: false,
            terminal: false,
            reasonCode: `DUAL_HOT_PASS2_NO_OUTPUT_code=${r2.code}`,
          };
          writeResultAtomic(outPath, finalRow);
        } else {
          const pass2 = JSON.parse(fs.readFileSync(tmp2, "utf8"));
          const agree =
            !pass1.error &&
            !pass2.error &&
            pass1.token === "HOT" &&
            pass2.token === "HOT" &&
            pass1.crawlComplete === true &&
            pass2.crawlComplete === true &&
            pass1.policyFound !== true &&
            pass2.policyFound !== true &&
            pass1.processingState === "HOT_VERIFIED" &&
            pass2.processingState === "HOT_VERIFIED";
          finalRow = {
            ...pass1,
            pass1: pass1.pass1,
            pass2: pass2.pass2 || pass2.pass1 || pass2,
            runIds: [...(pass1.runIds || []), ...(pass2.runIds || [])],
            frontierPaths: [...(pass1.frontierPaths || []), ...(pass2.frontierPaths || [])],
            fullEvidence: pass2.fullEvidence || pass1.fullEvidence,
            dualDisagreement: !agree,
            processingState: agree ? "HOT_VERIFIED" : "REVIEW_HUMAN",
            businessVerdict: agree ? "HOT_VERIFIED" : "REVIEW_HUMAN",
            validationStatus: agree ? pass2.validationStatus || pass1.validationStatus : "CONFLICT_FOUND",
            newVerdict: agree ? "HOT" : "REVIEW",
            token: agree ? "HOT" : "REVIEW",
            terminal: true,
            reasonCode: agree ? "HOT_VERIFIED" : "DUAL_HOT_DISAGREE",
            finishedAt: new Date().toISOString(),
          };
          writeResultAtomic(outPath, finalRow);
          try {
            fs.unlinkSync(tmp2);
          } catch {
            /* */
          }
        }
      }
    } else {
      writeResultAtomic(outPath, finalRow);
    }

    delete cp.inProgress[leadId];
    delete cp.retryQueue[leadId];
    const cls = classifyResult(finalRow);
    if (cls.kind === "terminal") {
      cp.terminal[leadId] = {
        finishedAt: finalRow.finishedAt || new Date().toISOString(),
        processingState: cls.state,
        newVerdict: finalRow.newVerdict,
        reasonCode: finalRow.reasonCode || cls.state,
      };
      cp.stats.terminal++;
      if (cls.state === "HOT_VERIFIED") cp.stats.hot++;
      else if (String(cls.state).startsWith("PUBLISHED")) cp.stats.pub++;
      else if (cls.state === "OUT_OF_SCOPE") cp.stats.outOfScope++;
      else if (cls.state === "TECHNICAL_BLOCKED") cp.stats.tech++;
      else cp.stats.review++;
    } else {
      const attempts = cp.attempts[leadId] || 1;
      if (attempts >= MAX_RETRY_ATTEMPTS) {
        cp.terminal[leadId] = {
          finishedAt: new Date().toISOString(),
          processingState: "TECHNICAL_BLOCKED",
          newVerdict: null,
          reasonCode: `RETRY_EXHAUSTED_${attempts}`,
        };
        finalRow.processingState = "TECHNICAL_BLOCKED";
        finalRow.reasonCode = `RETRY_EXHAUSTED_${attempts}`;
        finalRow.terminal = true;
        writeResultAtomic(outPath, finalRow);
        cp.stats.tech++;
        cp.stats.terminal++;
      } else {
        cp.retryQueue[leadId] = {
          attempts,
          lastReason: finalRow.processingState || "RETRY_PENDING",
          lastError: finalRow.error || finalRow.reasonCode || null,
          nextRetryAt: nextRetryAt(attempts),
          lastRunId: runId,
          frontierPath,
          firstSeenAt: cp.retryQueue[leadId]?.firstSeenAt || new Date().toISOString(),
          lastAttemptAt: new Date().toISOString(),
        };
        cp.stats.retry++;
      }
    }
    cp.stats.processed++;
    saveCheckpointAtomic(CHECKPOINT, cp);
    console.log(
      JSON.stringify({
        event: "lead_done",
        id: leadId,
        processingState: finalRow.processingState,
        kind: cls.kind,
        terminal: Object.keys(cp.terminal).length,
        retry: Object.keys(cp.retryQueue).length,
        total: leads.length,
      })
    );
  } catch (e) {
    delete cp.inProgress[leadId];
    const attempts = cp.attempts[leadId] || 1;
    cp.retryQueue[leadId] = {
      attempts,
      lastReason: "PARENT_CATCH",
      lastError: String(e),
      nextRetryAt: nextRetryAt(attempts),
      lastRunId: runId,
      frontierPath,
      firstSeenAt: new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(),
    };
    cp.stats.errors++;
    saveCheckpointAtomic(CHECKPOINT, cp);
    console.error(JSON.stringify({ event: "lead_error", id: leadId, error: String(e) }));
  } finally {
    releaseLeadLock(lock);
  }
}

let concurrency = Number(process.env.REVALIDATE_CONCURRENCY || 2);
concurrency = Math.min(3, Math.max(1, concurrency));

console.log(
  JSON.stringify({
    event: "revalidate_v3_start",
    testedCodeSha,
    totalCandidates: leads.length,
    terminal: Object.keys(cp.terminal).length,
    retryDue: dueRetryIds().length,
    pendingNew: pendingNewIds().length,
    concurrency,
    dualHot,
  })
);

const metricsEveryMs = 5 * 60_000;
let lastMetrics = Date.now();

async function metricsTick() {
  const freeMemMb = Math.round(os.freemem() / (1024 * 1024));
  const load = os.loadavg()[0];
  const terminal = Object.keys(cp.terminal).length;
  const retry = Object.keys(cp.retryQueue).length;
  const inProg = Object.keys(cp.inProgress).length;
  const remaining = leads.length - terminal;
  const rate = terminal > 0 ? terminal / ((Date.now() - new Date(cp.startedAt).getTime()) / 3600000) : 0;
  const etaH = rate > 0 ? remaining / rate : null;
  console.log(
    JSON.stringify({
      event: "metrics",
      terminal,
      retry,
      inProgress: inProg,
      hot: cp.stats.hot,
      pub: cp.stats.pub,
      outOfScope: cp.stats.outOfScope,
      tech: cp.stats.tech,
      concurrency,
      freeMemMb,
      load1: load,
      etaHours: etaH,
    })
  );
}

const workers = new Set();
async function pump() {
  while (!stopping) {
    if (Date.now() - lastMetrics > metricsEveryMs) {
      await metricsTick();
      lastMetrics = Date.now();
      concurrency = adaptiveConcurrency(concurrency);
    }
    const queue = [...dueRetryIds(), ...pendingNewIds()];
    if (limit != null && Number.isFinite(limit)) {
      // limit applies to new processing attempts this run
    }
    if (queue.length === 0 && workers.size === 0) break;
    while (workers.size < concurrency && queue.length && !stopping) {
      const id = queue.shift();
      if (!id || cp.terminal[id] || cp.inProgress[id]) continue;
      if (onlyIds && !onlyIds.has(id)) continue;
      const p = processLeadId(id).finally(() => workers.delete(p));
      workers.add(p);
    }
    if (workers.size === 0) {
      // wait for next retry
      const next = Object.values(cp.retryQueue)
        .map((m) => new Date(m.nextRetryAt || 0).getTime())
        .filter((t) => t > Date.now())
        .sort((a, b) => a - b)[0];
      if (!next) break;
      const wait = Math.min(60_000, Math.max(5_000, next - Date.now()));
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    await Promise.race([...workers, new Promise((r) => setTimeout(r, 5000))]);
  }
  await Promise.allSettled([...workers]);
}

await pump();
saveCheckpointAtomic(CHECKPOINT, cp);
await prisma.$disconnect().catch(() => {});
const remaining = leads.length - Object.keys(cp.terminal).length;
console.log(
  JSON.stringify({
    event: "revalidate_v3_end",
    stopping,
    terminal: Object.keys(cp.terminal).length,
    retry: Object.keys(cp.retryQueue).length,
    remaining,
    complete: remaining === 0 && Object.keys(cp.retryQueue).length === 0 && !stopping,
  })
);
process.exit(stopping ? 130 : remaining === 0 && Object.keys(cp.retryQueue).length === 0 ? 0 : 1);
