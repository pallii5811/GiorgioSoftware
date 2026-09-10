/**
 * Priority PUBLISHED batch — separate OUT_DIR, 3 workers, domain mutex, never HOT.
 * Preserves general checkpoint (does not touch REVALIDATE_OUT_DIR of giorgio-revalidate).
 *
 * Env:
 *   QUEUE_JSON=data/revalidation-published-priority/priority-queue.json
 *   REVALIDATE_OUT_DIR=.../revalidation-published-priority
 *   DATABASE_URL=file:...shadow...
 *   TOTAL_WORKERS=3
 *   MAX_PLAYWRIGHT=2 MAX_OCR=2
 *   APPLY_LIVE=0|1 BACKUP_META_PATH LIVE_DATABASE_URL
 *   AUTO_APPLY_CERTIFIED=1
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  emptyCheckpointV3,
  saveCheckpointAtomic,
  migrateCheckpointV2toV3,
  isTerminalState,
} from "./revalidate-checkpoint-v3.mjs";

const ROOT = path.resolve(".");
const QUEUE_JSON =
  process.env.QUEUE_JSON ||
  path.join(ROOT, "data/revalidation-published-priority/priority-queue.json");
const OUT_DIR = process.env.REVALIDATE_OUT_DIR
  ? path.resolve(process.env.REVALIDATE_OUT_DIR)
  : path.join(ROOT, "data/revalidation-published-priority");
const RESULTS_DIR = path.join(OUT_DIR, "results");
const FRONTIER_DIR = path.join(OUT_DIR, "frontiers");
const LOCK_DIR = path.join(OUT_DIR, "locks");
const CHECKPOINT = path.join(OUT_DIR, "checkpoint.json");
const WORKER = path.join(ROOT, "scripts/production-revalidate-sanita-worker.mjs");
const APPLY = path.join(ROOT, "scripts/production-apply-certified-lead.mjs");

const TOTAL = Math.min(3, Math.max(1, Number(process.env.TOTAL_WORKERS || 3)));
const MAX_OCR = Math.min(2, Math.max(1, Number(process.env.MAX_OCR || 2)));
const AUTO_APPLY = process.env.AUTO_APPLY_CERTIFIED === "1";
const APPLY_LIVE = process.env.APPLY_LIVE === "1";

fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.mkdirSync(FRONTIER_DIR, { recursive: true });
fs.mkdirSync(LOCK_DIR, { recursive: true });

if (!fs.existsSync(QUEUE_JSON)) {
  console.error("QUEUE_JSON missing — run build-published-priority-queue.mjs first");
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL required (shadow)");
  process.exit(2);
}
if (/\/opt\/leadsniper\/prisma\/dev\.db/i.test(process.env.DATABASE_URL) && process.env.ALLOW_LIVE_REVALIDATE !== "1") {
  console.error("Refusing live DB as worker DATABASE_URL");
  process.exit(2);
}

const queueDoc = JSON.parse(fs.readFileSync(QUEUE_JSON, "utf8"));
const items = queueDoc.queue || [];
const testedCodeSha = (process.env.GIT_HEAD || process.env.RELEASE_SHA || "").trim() || null;

let cp;
if (fs.existsSync(CHECKPOINT)) {
  cp = migrateCheckpointV2toV3(JSON.parse(fs.readFileSync(CHECKPOINT, "utf8"))).checkpoint;
} else {
  cp = emptyCheckpointV3(testedCodeSha);
}
cp.testedCodeSha = testedCodeSha || cp.testedCodeSha;

const report = {
  startedAt: new Date().toISOString(),
  queueCount: items.length,
  certified: 0,
  expired: 0,
  current: 0,
  dateUnknown: 0,
  retry: 0,
  review: 0,
  tech: 0,
  falseRejected: 0,
  appliedLive: 0,
  dryRunOk: 0,
  errors: 0,
  perLead: [],
};

const domainBusy = new Map(); // domain -> promise
let ocrSlots = 0;
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});

function spawnWorker(leadId) {
  return new Promise((resolve) => {
    const frontierPath = path.join(FRONTIER_DIR, `${leadId}.sqlite`);
    const outPath = path.join(RESULTS_DIR, `${leadId}.json`);
    const tmpOut = path.join(RESULTS_DIR, `${leadId}.p1.json`);
    const runId = `pubprio-${leadId}-${Date.now()}`;
    const env = {
      ...process.env,
      REVALIDATE_LEAD_ID: leadId,
      REVALIDATE_PASS: "p1",
      REVALIDATE_OUT: tmpOut,
      REVALIDATE_MODE: "published-priority",
      FRONTIER_DB_PATH: frontierPath,
      SHADOW_RUN_ID: runId,
      SCAN_ENGINE_LOCAL: "1",
      OCR_ENABLED: "1",
      POLICY_EXHAUSTIVE: "1",
      SCAN_FAST: "0",
      STAGING_MODE: "true",
      DISABLE_LIVE_DB: "true",
      DISABLE_EMAILS: "true",
      PER_HOST_CONCURRENCY: "1",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --max-old-space-size=3072`.trim(),
    };
    // OCR slot soft-cap: wait if saturated
    const waitOcr = async () => {
      while (ocrSlots >= MAX_OCR && !stopping) {
        await new Promise((r) => setTimeout(r, 500));
      }
      ocrSlots++;
    };
    waitOcr().then(() => {
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
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("close", (code) => {
        ocrSlots = Math.max(0, ocrSlots - 1);
        try {
          if (fs.existsSync(tmpOut)) {
            fs.renameSync(tmpOut, outPath);
          }
        } catch {
          /* */
        }
        resolve({ code, stdout, stderr, outPath });
      });
    });
  });
}

async function maybeApply(id, processingState) {
  if (!["PUBLISHED_CURRENT", "PUBLISHED_EXPIRED", "PUBLISHED_DATE_UNKNOWN"].includes(processingState)) {
    return;
  }
  const dry = spawn(
    "npx",
    ["tsx", APPLY],
    {
      env: {
        ...process.env,
        APPLY_IDS: id,
        APPLY_LIVE: "0",
        REVALIDATE_RESULTS_DIR: RESULTS_DIR,
      },
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    }
  );
  const dryOut = await new Promise((resolve) => {
    let o = "";
    dry.stdout.on("data", (d) => {
      o += d.toString();
    });
    dry.on("close", (c) => resolve({ c, o }));
  });
  if (dryOut.c !== 0) {
    report.errors++;
    console.log(JSON.stringify({ event: "dry_run_fail", id, code: dryOut.c }));
    return;
  }
  report.dryRunOk++;
  console.log(JSON.stringify({ event: "dry_run_ok", id, processingState }));
  if (!AUTO_APPLY || !APPLY_LIVE) return;
  const live = spawn("npx", ["tsx", APPLY], {
    env: {
      ...process.env,
      APPLY_IDS: id,
      APPLY_LIVE: "1",
      REVALIDATE_RESULTS_DIR: RESULTS_DIR,
      BACKUP_META_PATH: process.env.BACKUP_META_PATH,
      LIVE_DATABASE_URL: process.env.LIVE_DATABASE_URL,
    },
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  const liveOut = await new Promise((resolve) => {
    let o = "";
    live.stdout.on("data", (d) => {
      o += d.toString();
    });
    live.stderr.on("data", (d) => {
      o += d.toString();
    });
    live.on("close", (c) => resolve({ c, o }));
  });
  if (liveOut.c === 0) {
    report.appliedLive++;
    console.log(JSON.stringify({ event: "applied_live", id, processingState }));
  } else {
    report.errors++;
    console.log(JSON.stringify({ event: "apply_live_fail", id, out: liveOut.o.slice(-500) }));
  }
}

async function processOne(item) {
  const id = item.id;
  if (cp.terminal[id]) return;
  const domain = item.domain || "unknown";
  while (domainBusy.has(domain) && !stopping) {
    await domainBusy.get(domain);
  }
  if (stopping) return;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  domainBusy.set(domain, gate);
  cp.inProgress[id] = { startedAt: new Date().toISOString(), domain, mode: "published-priority" };
  cp.attempts[id] = (cp.attempts[id] || 0) + 1;
  saveCheckpointAtomic(CHECKPOINT, cp);
  try {
    const { code, outPath } = await spawnWorker(id);
    delete cp.inProgress[id];
    if (!fs.existsSync(outPath)) {
      report.errors++;
      cp.retryQueue[id] = {
        nextRetryAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        reason: "missing_result",
        attempts: cp.attempts[id],
      };
      saveCheckpointAtomic(CHECKPOINT, cp);
      return;
    }
    const row = JSON.parse(fs.readFileSync(outPath, "utf8"));
    const st = row.processingState;
    // Guard: never accept HOT on this batch
    if (st === "HOT_VERIFIED" || row.newVerdict === "HOT") {
      report.falseRejected++;
      row.processingState = "RETRY_PENDING";
      row.newVerdict = null;
      fs.writeFileSync(outPath, JSON.stringify(row, null, 2));
    }
    const state = row.processingState;
    if (isTerminalState(state) && state !== "RETRY_PENDING") {
      cp.terminal[id] = {
        processingState: state,
        finishedAt: new Date().toISOString(),
        mode: "published-priority",
      };
      delete cp.retryQueue[id];
      if (state === "PUBLISHED_CURRENT") {
        report.current++;
        report.certified++;
      } else if (state === "PUBLISHED_EXPIRED") {
        report.expired++;
        report.certified++;
      } else if (state === "PUBLISHED_DATE_UNKNOWN") {
        report.dateUnknown++;
        report.certified++;
      } else if (state === "REVIEW_HUMAN") report.review++;
      else if (state === "TECHNICAL_BLOCKED") report.tech++;
      cp.stats.processed = (cp.stats.processed || 0) + 1;
      if (String(state).startsWith("PUBLISHED")) cp.stats.pub = (cp.stats.pub || 0) + 1;
      saveCheckpointAtomic(CHECKPOINT, cp);
      report.perLead.push({ id, companyName: item.companyName, state, code });
      await maybeApply(id, state);
    } else {
      report.retry++;
      cp.retryQueue[id] = {
        nextRetryAt: new Date(Date.now() + 20 * 60_000).toISOString(),
        reason: row.reasonCode || "retry",
        attempts: cp.attempts[id],
      };
      cp.stats.processed = (cp.stats.processed || 0) + 1;
      cp.stats.retry = (cp.stats.retry || 0) + 1;
      saveCheckpointAtomic(CHECKPOINT, cp);
      report.perLead.push({ id, companyName: item.companyName, state, code });
    }
  } catch (e) {
    report.errors++;
    delete cp.inProgress[id];
    console.error(JSON.stringify({ event: "lead_error", id, error: String(e) }));
    saveCheckpointAtomic(CHECKPOINT, cp);
  } finally {
    domainBusy.delete(domain);
    release();
  }
}

console.log(
  JSON.stringify({
    event: "published_priority_start",
    queue: items.length,
    workers: TOTAL,
    maxOcr: MAX_OCR,
    autoApply: AUTO_APPLY,
    applyLive: APPLY_LIVE,
    outDir: OUT_DIR,
  })
);

const t0 = Date.now();
const pending = items.filter((i) => !cp.terminal[i.id]);
let idx = 0;
const inflight = new Set();

async function pump() {
  while (!stopping && (idx < pending.length || inflight.size)) {
    while (!stopping && inflight.size < TOTAL && idx < pending.length) {
      const item = pending[idx++];
      const p = processOne(item).finally(() => inflight.delete(p));
      inflight.add(p);
    }
    if (inflight.size === 0) break;
    await Promise.race([...inflight, new Promise((r) => setTimeout(r, 2000))]);
  }
  await Promise.allSettled([...inflight]);
}

await pump();
saveCheckpointAtomic(CHECKPOINT, cp);
report.finishedAt = new Date().toISOString();
report.elapsedMs = Date.now() - t0;
report.terminal = Object.keys(cp.terminal).length;
report.throughputPerHour =
  report.elapsedMs > 0 ? (report.terminal / (report.elapsedMs / 3600000)).toFixed(2) : null;
const remaining = items.length - report.terminal;
report.etaHours =
  report.throughputPerHour && Number(report.throughputPerHour) > 0
    ? (remaining / Number(report.throughputPerHour)).toFixed(2)
    : null;
fs.writeFileSync(path.join(OUT_DIR, "priority-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ event: "published_priority_end", ...report, remaining }, null, 2));
process.exit(stopping ? 130 : 0);
