import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { prisma } from "@/lib/prisma";
import { packEvidence } from "@/lib/sanita/audit";
import {
  resolveAfterTechnicalFailure,
  stampProcessingMeta,
} from "@/lib/sanita/processing-state";
import {
  readSanitaJob,
  writeSanitaJob,
  listSanitaJobs,
  type SanitaJobRecord,
} from "@/lib/sanita/jobs";
import { releaseJobTargetLock } from "@/lib/sanita/job-target-lock";

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === "0") return 0;
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Per-lead cap inside job runner (default 10 min). */
export const SANITA_JOB_LEAD_MAX_MS = envMs("SANITA_JOB_LEAD_MAX_MS", 10 * 60_000);

/** Parent watchdog: kill runner if heartbeat older than this (default 2 min). */
export const SANITA_JOB_STALE_MS = envMs("SANITA_JOB_STALE_MS", 2 * 60_000);

/** Grace period for queued+pid spawn transition (default 45s). */
export const SANITA_JOB_QUEUED_PID_GRACE_MS = envMs("SANITA_JOB_QUEUED_PID_GRACE_MS", 45_000);

export const SANITA_JOB_HEARTBEAT_MS = envMs("SANITA_JOB_HEARTBEAT_MS", 15_000);

export const SANITA_JOB_RECONCILE_INTERVAL_MS = envMs("SANITA_JOB_RECONCILE_INTERVAL_MS", 30_000);

export type ProcessInspectResult = "absent" | "foreign" | "valid" | "unknown";

export type ReconcileDeps = {
  isProcessAlive?: (pid: number) => boolean;
  readCmdline?: (pid: number) => string | null;
  killProcess?: (pid: number) => void;
  killProcessControlled?: (pid: number) => void;
};

export type ReconcileOutcome =
  | { action: "unchanged" }
  | { action: "reconciled"; reason: string; killed: boolean };

let reconcileTimer: ReturnType<typeof setInterval> | null = null;

export function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readProcessCmdline(pid: number): string | null {
  if (!pid || pid <= 0) return null;
  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "wmic",
        ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/format:list"],
        { encoding: "utf8", timeout: 5000 }
      );
      const m = out.match(/CommandLine=(.+)/);
      return m?.[1]?.trim() ?? null;
    } catch {
      return null;
    }
  }
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch {
    return null;
  }
}

export function matchesSanitaJobRunner(cmdline: string | null, jobId: string): boolean {
  if (!cmdline) return false;
  return /sanita-job-runner/i.test(cmdline) && cmdline.includes(jobId);
}

export function inspectSanitaJobProcess(
  pid: number | null | undefined,
  jobId: string,
  deps: ReconcileDeps = {}
): ProcessInspectResult {
  if (!pid || pid <= 0) return "absent";
  const alive = (deps.isProcessAlive ?? isProcessAlive)(pid);
  if (!alive) return "absent";
  const cmdline = (deps.readCmdline ?? readProcessCmdline)(pid);
  if (!cmdline) return "unknown";
  return matchesSanitaJobRunner(cmdline, jobId) ? "valid" : "foreign";
}

export function killProcessTree(pid: number | null | undefined) {
  if (!pid || pid <= 0) return;
  try {
    process.kill(-pid, "SIGTERM");
    return;
  } catch {
    /* fall through */
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already dead */
  }
}

function syncSleepMs(ms: number) {
  if (ms <= 0) return;
  if (process.platform === "win32") {
    try {
      execFileSync("powershell", ["-Command", `Start-Sleep -Milliseconds ${ms}`], {
        timeout: ms + 2000,
        stdio: "ignore",
      });
      return;
    } catch {
      /* fall through */
    }
  }
  try {
    execFileSync("sleep", [String(Math.max(0.001, ms / 1000))], {
      timeout: ms + 2000,
      stdio: "ignore",
    });
    return;
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* ponytail: busy-wait fallback */
    }
  }
}

/** SIGTERM → attesa → SIGKILL se il processo resta vivo. */
export function killProcessTreeControlled(
  pid: number | null | undefined,
  deps: ReconcileDeps = {}
) {
  if (!pid || pid <= 0) return;
  const killer = deps.killProcessControlled ?? ((p: number) => killProcessTree(p));
  killer(pid);
  const deadline = Date.now() + 5000;
  const alive = deps.isProcessAlive ?? isProcessAlive;
  while (Date.now() < deadline) {
    if (!alive(pid)) return;
    syncSleepMs(200);
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
}

export async function markLeadJobIncomplete(
  leadId: string,
  message: string,
  opts?: { retriesExhausted?: boolean }
) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return;
  const resolved = resolveAfterTechnicalFailure({
    previousEvidence: lead.evidence,
    error: message,
    retriesExhausted: opts?.retriesExhausted ?? true,
  });
  const verdict =
    resolved.keepLegacyToken === "PUBLISHED"
      ? "PUBLISHED"
      : resolved.keepLegacyToken === "HOT"
        ? "HOT"
        : "REVIEW";
  const body = `Verifica non completata. ${message}`;
  let evidence = packEvidence(verdict as "PUBLISHED" | "HOT" | "REVIEW", body, { mapsLookup: true });
  evidence = stampProcessingMeta(evidence, {
    state: resolved.state,
    businessVerdict: resolved.businessVerdict,
    validationStatus: resolved.validationStatus,
  });
  await prisma.lead.update({
    where: { id: leadId },
    data: {
      lastScannedAt: new Date(),
      evidence,
    },
  });
}

export function startJobHeartbeat(
  jobId: string,
  patch?: () => Partial<SanitaJobRecord["progress"]>
): () => void {
  const timer = setInterval(() => {
    const current = readSanitaJob(jobId);
    if (!current || current.status !== "running") return;
    writeSanitaJob(
      {
        ...current,
        progress: {
          ...current.progress,
          ...(patch?.() || {}),
          currentMessage: current.progress.currentMessage || "Verifica in corso.",
        },
      },
      { touchHeartbeat: true }
    );
  }, SANITA_JOB_HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function runWithJobLeadTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return fn();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Verifica non completata entro ${Math.round(timeoutMs / 60_000)} min`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function writeJobCheckpoint(job: SanitaJobRecord, extra?: Record<string, unknown>) {
  if (!job.namespace) return;
  const dir = path.join(process.cwd(), job.namespace);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "checkpoint.json");
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  const payload = {
    ...existing,
    jobId: job.jobId,
    mode: job.mode,
    status: job.status,
    updatedAt: job.updatedAt,
    leadId: job.leadId,
    processed: job.processed ?? null,
    ...extra,
  };
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, file);
}

function isActiveWithPid(job: SanitaJobRecord) {
  if (job.cancelRequested) return false;
  return (job.status === "queued" || job.status === "running") && Boolean(job.pid);
}

function heartbeatAgeMs(job: SanitaJobRecord, now: number): number {
  const hb = job.lastHeartbeatAt ? Date.parse(job.lastHeartbeatAt) : 0;
  if (!hb) return Number.POSITIVE_INFINITY;
  return now - hb;
}

function queuedPidGraceRemainingMs(job: SanitaJobRecord, now: number): number {
  const ref = job.updatedAt ? Date.parse(job.updatedAt) : 0;
  if (!ref) return 0;
  return SANITA_JOB_QUEUED_PID_GRACE_MS - (now - ref);
}

export function finalizeZombieSanitaJob(
  job: SanitaJobRecord,
  reason: string,
  extra?: Record<string, unknown>
): SanitaJobRecord {
  releaseJobTargetLock(job.targetKey, job.jobId);
  const checkpointBefore = job.namespace
    ? fs.existsSync(path.join(process.cwd(), job.namespace, "checkpoint.json"))
    : false;
  const next = writeSanitaJob({
    ...job,
    status: "failed",
    finishedAt: new Date().toISOString(),
    resumable: true,
    pid: null,
    lastUpdateLabel: "Verifica non completata",
    errorMessage: reason,
    progress: {
      ...job.progress,
      currentMessage: "Verifica non completata.",
      currentStructure: null,
    },
  });
  if (checkpointBefore) {
    writeJobCheckpoint(next, { reconcile: reason, ...extra });
  }
  return next;
}

export function reconcileOneSanitaJob(
  job: SanitaJobRecord,
  now = Date.now(),
  deps: ReconcileDeps = {}
): ReconcileOutcome {
  if (
    job.cancelRequested &&
    (job.status === "queued" || job.status === "running")
  ) {
    let killed = false;
    if (job.pid) {
      const inspect = inspectSanitaJobProcess(job.pid, job.jobId, deps);
      if (inspect === "valid") {
        if (deps.killProcessControlled) deps.killProcessControlled(job.pid);
        else killProcessTreeControlled(job.pid, deps);
        killed = true;
      }
    }
    releaseJobTargetLock(job.targetKey, job.jobId);
    writeSanitaJob({
      ...job,
      status: "cancelled",
      finishedAt: new Date().toISOString(),
      resumable: false,
      pid: null,
      lastUpdateLabel: "Interrotto",
      progress: {
        ...job.progress,
        currentMessage: "Controllo interrotto.",
        currentStructure: null,
      },
    });
    return { action: "reconciled", reason: "cancel_requested", killed };
  }

  if (!isActiveWithPid(job)) {
    if (
      (job.status === "queued" || job.status === "running") &&
      !job.pid &&
      !job.cancelRequested
    ) {
      const age = job.updatedAt ? now - Date.parse(job.updatedAt) : 0;
      if (age > SANITA_JOB_QUEUED_PID_GRACE_MS) {
        finalizeZombieSanitaJob(job, "Watchdog: job attivo senza processo");
        return { action: "reconciled", reason: "active_without_pid", killed: false };
      }
    }
    return { action: "unchanged" };
  }

  if (job.status === "queued") {
    const grace = queuedPidGraceRemainingMs(job, now);
    if (grace > 0) return { action: "unchanged" };
  }

  const inspect = inspectSanitaJobProcess(job.pid, job.jobId, deps);

  if (inspect === "absent") {
    finalizeZombieSanitaJob(job, "Watchdog: processo job assente");
    return { action: "reconciled", reason: "pid_absent", killed: false };
  }

  if (inspect === "foreign") {
    finalizeZombieSanitaJob(job, "Watchdog: PID non corrisponde al job");
    return { action: "reconciled", reason: "pid_foreign", killed: false };
  }

  if (inspect === "unknown") {
    if (job.status === "running" && heartbeatAgeMs(job, now) >= SANITA_JOB_STALE_MS) {
      if (job.pid) {
        if (deps.killProcessControlled) deps.killProcessControlled(job.pid);
        else killProcessTreeControlled(job.pid, deps);
      }
      finalizeZombieSanitaJob(job, "Watchdog: heartbeat scaduto (cmdline non verificabile)");
      return { action: "reconciled", reason: "stale_heartbeat_unknown_cmd", killed: true };
    }
    return { action: "unchanged" };
  }

  // valid runner
  if (job.status === "running" && heartbeatAgeMs(job, now) >= SANITA_JOB_STALE_MS) {
    if (job.pid) {
      if (deps.killProcessControlled) deps.killProcessControlled(job.pid);
      else killProcessTreeControlled(job.pid, deps);
    }
    finalizeZombieSanitaJob(job, "Watchdog: heartbeat scaduto");
    return { action: "reconciled", reason: "stale_heartbeat", killed: true };
  }

  if (job.status === "queued") {
    const grace = queuedPidGraceRemainingMs(job, now);
    if (grace <= 0 && heartbeatAgeMs(job, now) >= SANITA_JOB_STALE_MS) {
      if (job.pid) {
        if (deps.killProcessControlled) deps.killProcessControlled(job.pid);
        else killProcessTreeControlled(job.pid, deps);
      }
      finalizeZombieSanitaJob(job, "Watchdog: job in coda bloccato");
      return { action: "reconciled", reason: "queued_stuck", killed: true };
    }
  }

  return { action: "unchanged" };
}

export function reconcileStaleSanitaJobs(now = Date.now(), deps: ReconcileDeps = {}) {
  const jobs = listSanitaJobs();
  const reconciled: Array<{ jobId: string; reason: string }> = [];
  for (const job of jobs) {
    const outcome = reconcileOneSanitaJob(job, now, deps);
    if (outcome.action === "reconciled") {
      reconciled.push({ jobId: job.jobId, reason: outcome.reason });
    }
  }
  return reconciled;
}

export function ensureSanitaJobWatchdog() {
  if (reconcileTimer) return;
  reconcileStaleSanitaJobs();
  reconcileTimer = setInterval(() => {
    reconcileStaleSanitaJobs();
  }, SANITA_JOB_RECONCILE_INTERVAL_MS);
  reconcileTimer.unref?.();
}
