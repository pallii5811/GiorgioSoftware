/**
 * Checkpoint v3 helpers for Sanità revalidation — shared by parent + tests.
 * RETRY_PENDING is never terminal.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** Commercial/semantic terminals only. TECHNICAL_BLOCKED is admin quarantine, not auto-assigned. */
export const TERMINAL_STATES = new Set([
  "HOT_VERIFIED",
  "PUBLISHED_CURRENT",
  "PUBLISHED_EXPIRED",
  "PUBLISHED_DATE_UNKNOWN",
  "SELF_INSURANCE_VERIFIED",
  "REVIEW_HUMAN",
  "OUT_OF_SCOPE",
]);

/** Hard ceiling — exceeded attempts become admin TECHNICAL_BLOCKED (no hot-loop). */
export const MAX_RETRY_ATTEMPTS = Number(process.env.REVALIDATE_MAX_RETRY || 5);
/** Backoff base; sliceContinue still respects backoff (no 5s hot-loop). */
export const RETRY_BASE_MS = Number(process.env.REVALIDATE_RETRY_BASE_MS || 90_000);

export function emptyCheckpointV3(testedCodeSha) {
  return {
    version: 3,
    testedCodeSha,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    terminal: {},
    retryQueue: {},
    inProgress: {},
    attempts: {},
    stats: {
      processed: 0,
      terminal: 0,
      hot: 0,
      pub: 0,
      review: 0,
      retry: 0,
      tech: 0,
      outOfScope: 0,
      errors: 0,
    },
  };
}

export function isTerminalState(processingState) {
  return TERMINAL_STATES.has(processingState);
}

export function classifyResult(row) {
  const ps = row.processingState || row.reasonCode || null;
  if (row.dualDisagreement) return { kind: "terminal", state: "REVIEW_HUMAN" };
  if (ps === "RETRY_PENDING" || row.newVerdict == null && /RETRY/i.test(String(ps || ""))) {
    return { kind: "retry", state: "RETRY_PENDING" };
  }
  if (isTerminalState(ps)) return { kind: "terminal", state: ps };
  // map token fallbacks
  if (row.newVerdict === "HOT" && row.crawlComplete && ps === "HOT_VERIFIED") {
    return { kind: "terminal", state: "HOT_VERIFIED" };
  }
  if (row.newVerdict === "PUBLISHED") {
    if (ps && isTerminalState(ps)) return { kind: "terminal", state: ps };
    return { kind: "terminal", state: ps || "PUBLISHED_DATE_UNKNOWN" };
  }
  // Admin quarantine terminal (not commercial) — stops hot-loops / unreachable hosts.
  if (ps === "TECHNICAL_BLOCKED" || /RETRY_EXHAUSTED/i.test(String(row.reasonCode || ""))) {
    return { kind: "terminal", state: "TECHNICAL_BLOCKED" };
  }
  if (row.error || /TIMEOUT|ANALYZE_ERROR|LEAD_WALL/i.test(String(row.reasonCode || ""))) {
    return { kind: "retry", state: "RETRY_PENDING" };
  }
  // unknown incomplete → retry, never terminal certify
  return { kind: "retry", state: "RETRY_PENDING" };
}

export function nextRetryAt(attempts, opts = {}) {
  if (opts.immediate) {
    return new Date(Date.now() + Number(opts.delayMs || 5_000)).toISOString();
  }
  const n = Math.max(0, Number(attempts) || 0);
  // Cap exponential at 20 min.
  const delay = Math.min(20 * 60_000, RETRY_BASE_MS * Math.pow(2, Math.min(n, 4)));
  // Slice continuation still backs off (min 30s) — never 5s hot-loop.
  if (opts.sliceContinue) {
    return new Date(Date.now() + Math.max(30_000, Math.min(delay, 5 * 60_000))).toISOString();
  }
  return new Date(Date.now() + delay).toISOString();
}

/**
 * Retry strategy rotation — never identical infinite loops.
 * resume: same frontier (default for CAP/INCOMPLETE/PDF/WALL/SIGTERM)
 * resume_boost: same frontier + higher HTML/PDF budget
 * fresh: new frontier only after repeated identical external blocks
 */
export function pickRetryStrategy(attempts, lastError, lastStrategy) {
  const err = String(lastError || "");
  const n = Math.max(0, Number(attempts) || 0);
  // Identity mismatch may need a clean seed surface — only allowed fresh case.
  if (/IDENTITY/i.test(err)) return "fresh";
  // STOP-SHIP: never wipe frontier for CAP/incomplete — resume (+boost) only.
  if (n <= 1) return "resume";
  if (n >= 2) return "resume_boost";
  return lastStrategy === "resume_boost" ? "resume_boost" : "resume";
}

/**
 * Migrate v2 { done } checkpoint → v3 { terminal, retryQueue }.
 * Preserves result files; RETRY_PENDING entries move to retryQueue.
 */
export function migrateCheckpointV2toV3(cp, resultsDir, testedCodeSha) {
  if (cp?.version >= 3 && cp.terminal && cp.retryQueue) {
    cp.testedCodeSha = cp.testedCodeSha || testedCodeSha;
    // Incomplete hand-written / reset checkpoints may omit attempts/stats.
    if (!cp.attempts || typeof cp.attempts !== "object") cp.attempts = {};
    if (!cp.inProgress || typeof cp.inProgress !== "object") cp.inProgress = {};
    if (!cp.stats || typeof cp.stats !== "object") {
      cp.stats = emptyCheckpointV3(cp.testedCodeSha || testedCodeSha || null).stats;
    }
    return { checkpoint: cp, migrated: 0, terminal: Object.keys(cp.terminal).length, retry: Object.keys(cp.retryQueue).length };
  }
  const out = emptyCheckpointV3(testedCodeSha || cp?.testedCodeSha || null);
  out.startedAt = cp?.startedAt || out.startedAt;
  let migrated = 0;
  const done = cp?.done || {};
  for (const [id, meta] of Object.entries(done)) {
    const resultPath = path.join(resultsDir, `${id}.json`);
    let row = null;
    if (fs.existsSync(resultPath)) {
      try {
        row = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      } catch {
        row = null;
      }
    }
    const processingState = row?.processingState || meta?.processingState || meta?.reasonCode || null;
    const synthetic = row || {
      id,
      processingState,
      newVerdict: meta?.newVerdict ?? null,
      reasonCode: meta?.reasonCode,
      dualDisagreement: false,
    };
    const cls = classifyResult(synthetic);
    out.attempts[id] = (out.attempts[id] || 0) + 1;
    if (cls.kind === "terminal") {
      out.terminal[id] = {
        finishedAt: meta?.finishedAt || row?.finishedAt || new Date().toISOString(),
        processingState: cls.state,
        newVerdict: row?.newVerdict ?? meta?.newVerdict ?? null,
        reasonCode: row?.reasonCode || meta?.reasonCode || cls.state,
      };
      bumpStats(out, cls.state);
    } else {
      out.retryQueue[id] = {
        attempts: out.attempts[id],
        lastReason: processingState || "RETRY_PENDING",
        lastError: row?.pass1?.error || row?.reasonCode || null,
        nextRetryAt: new Date(0).toISOString(), // due immediately for the 5 known retries
        lastRunId: row?.pass1?.runId || null,
        frontierPath: row?.pass1?.frontierPath || null,
        firstSeenAt: meta?.finishedAt || row?.finishedAt || new Date().toISOString(),
        lastAttemptAt: meta?.finishedAt || row?.finishedAt || new Date().toISOString(),
      };
      out.stats.retry++;
      migrated++;
    }
    out.stats.processed++;
  }
  out.updatedAt = new Date().toISOString();
  return {
    checkpoint: out,
    migrated,
    terminal: Object.keys(out.terminal).length,
    retry: Object.keys(out.retryQueue).length,
  };
}

function bumpStats(cp, state) {
  cp.stats.terminal++;
  if (state === "HOT_VERIFIED") cp.stats.hot++;
  else if (state === "SELF_INSURANCE_VERIFIED") cp.stats.pub++;
  else if (String(state).startsWith("PUBLISHED")) cp.stats.pub++;
  else if (state === "REVIEW_HUMAN") cp.stats.review++;
  else if (state === "TECHNICAL_BLOCKED") cp.stats.tech++;
  else if (state === "OUT_OF_SCOPE") cp.stats.outOfScope++;
  else cp.stats.review++;
}

export function saveCheckpointAtomic(filePath, cp) {
  cp.updatedAt = new Date().toISOString();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + `.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(cp, null, 2));
  try {
    const fd = fs.openSync(tmp, "r+");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch {
    /* best-effort fsync */
  }
  fs.renameSync(tmp, filePath);
}

export function writeResultAtomic(filePath, row) {
  const body = JSON.stringify(row, null, 2);
  const hash = crypto.createHash("sha256").update(body).digest("hex");
  row.resultHash = hash;
  row.schemaVersion = row.schemaVersion || 3;
  row.generatedAt = row.generatedAt || new Date().toISOString();
  const finalBody = JSON.stringify(row, null, 2);
  // re-hash after hash field (stable for content sans hash: store contentHash separately)
  row.contentHash = crypto.createHash("sha256").update(JSON.stringify({ ...row, resultHash: undefined, contentHash: undefined })).digest("hex");
  const out = JSON.stringify(row, null, 2);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + `.tmp.${process.pid}`;
  fs.writeFileSync(tmp, out);
  try {
    const fd = fs.openSync(tmp, "r+");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch {
    /* ignore */
  }
  fs.renameSync(tmp, filePath);
  return row;
}

export function resultHasRequiredFields(row) {
  if (!row || typeof row !== "object") return false;
  if (!row.id) return false;
  if (typeof row.fullEvidence !== "string") return false;
  if (!row.processingState) return false;
  if (!row.schemaVersion) return false;
  return true;
}
