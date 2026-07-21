import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { packEvidence } from "@/lib/sanita/audit";
import {
  resolveAfterTechnicalFailure,
  stampProcessingMeta,
} from "@/lib/sanita/processing-state";
import { readSanitaJob, writeSanitaJob, listSanitaJobs, type SanitaJobRecord } from "@/lib/sanita/jobs";

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

export const SANITA_JOB_HEARTBEAT_MS = envMs("SANITA_JOB_HEARTBEAT_MS", 15_000);

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
    writeSanitaJob({
      ...current,
      progress: {
        ...current.progress,
        ...(patch?.() || {}),
        currentMessage: current.progress.currentMessage || "Verifica in corso.",
      },
    });
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
  const payload = {
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

export function reconcileStaleSanitaJobs(now = Date.now()) {
  const jobs = listSanitaJobs();
  const reconciled: string[] = [];
  for (const job of jobs) {
    if (job.status !== "running") continue;
    const hb = job.lastHeartbeatAt ? Date.parse(job.lastHeartbeatAt) : 0;
    if (!hb || now - hb < SANITA_JOB_STALE_MS) continue;
    if (job.pid) killProcessTree(job.pid);
    writeSanitaJob({
      ...job,
      status: "failed",
      finishedAt: new Date().toISOString(),
      resumable: true,
      pid: null,
      lastUpdateLabel: "Errore",
      errorMessage: "Watchdog: job senza heartbeat",
      progress: {
        ...job.progress,
        currentMessage: "Verifica non completata: job interrotto dal watchdog.",
        currentStructure: null,
      },
    });
    writeJobCheckpoint(job, { watchdog: "stale_heartbeat" });
    reconciled.push(job.jobId);
  }
  return reconciled;
}
