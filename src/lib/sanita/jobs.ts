import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
export type SanitaJobMode = "single" | "city" | "region" | "region-canary";
export type SanitaJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "interrupted"
  | "cancelled"
  | "failed";

export type SanitaJobProgress = {
  structuresControlled: number;
  totalStructures: number | null;
  certifiedResults: number;
  autoVerificationsPending: number;
  manualChecksNeeded: number;
  percent: number | null;
  currentMessage: string | null;
  currentStructure: string | null;
};

export type SanitaJobCanaryLead = {
  id: string;
  companyName: string;
  city: string | null;
};

export type SanitaJobRecord = {
  jobId: string;
  mode: SanitaJobMode;
  status: SanitaJobStatus;
  targetKey: string;
  region: "Veneto" | "Campania";
  city: string | null;
  leadId: string | null;
  /** Canary: cap fisso (max 3). */
  targetTotal?: number | null;
  /** Canary: strutture analizzate in questo job. */
  processed?: number;
  /** Canary: null = job nuovo, mai ripreso da checkpoint regionale. */
  resumedFrom?: string | null;
  noResume?: boolean;
  namespace?: string | null;
  canaryLeadIds?: string[];
  canaryLeads?: SanitaJobCanaryLead[];
  forceRescan?: boolean;
  skipExistingEvidence?: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastHeartbeatAt: string | null;
  lastUpdateLabel: string | null;
  resumable: boolean;
  cancelRequested: boolean;
  pid: number | null;
  progress: SanitaJobProgress;
  errorMessage: string | null;
};

export const REGION_CANARY_MAX_TARGETS = 3;

const JOBS_DIR = path.join(process.cwd(), "data", "sanita-jobs");

export function ensureJobsDir() {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
}

export function getSanitaJobsDir() {
  ensureJobsDir();
  return JOBS_DIR;
}

export function getSanitaJobPath(jobId: string) {
  return path.join(getSanitaJobsDir(), `${jobId}.json`);
}

export function buildTargetKey(input: {
  mode: SanitaJobMode;
  region: "Veneto" | "Campania";
  city?: string | null;
  leadId?: string | null;
  jobId?: string;
}) {
  if (input.mode === "single") return `single:${input.leadId}`;
  if (input.mode === "city") return `city:${input.region}:${(input.city || "").trim().toLowerCase()}`;
  if (input.mode === "region-canary") return `region-canary:${input.jobId}`;
  return `region:${input.region}`;
}

export function getSanitaJobNamespace(jobId: string) {
  return path.join("data", "sanita-jobs", jobId);
}

export function getSanitaJobCheckpointPath(jobId: string) {
  return path.join(getSanitaJobNamespace(jobId), "checkpoint.json");
}

export function writeRegionCanaryCheckpoint(job: SanitaJobRecord) {
  const dir = path.join(process.cwd(), getSanitaJobNamespace(job.jobId));
  fs.mkdirSync(dir, { recursive: true });
  const checkpoint = {
    jobId: job.jobId,
    mode: "region-canary" as const,
    targetTotal: job.targetTotal ?? REGION_CANARY_MAX_TARGETS,
    processed: job.processed ?? 0,
    resumedFrom: job.resumedFrom ?? null,
    noResume: true,
    region: job.region,
    leadIds: job.canaryLeadIds ?? [],
    leads: job.canaryLeads ?? [],
    createdAt: job.createdAt,
  };
  const file = path.join(dir, "checkpoint.json");
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(checkpoint, null, 2));
  fs.renameSync(tmp, file);
  return checkpoint;
}

export function emptySanitaJob(input: {
  jobId: string;
  mode: SanitaJobMode;
  region: "Veneto" | "Campania";
  city?: string | null;
  leadId?: string | null;
  canaryLeadIds?: string[];
  canaryLeads?: SanitaJobCanaryLead[];
  forceRescan?: boolean;
  skipExistingEvidence?: boolean;
}) {
  const now = new Date().toISOString();
  const isCanary = input.mode === "region-canary";
  const targetTotal = isCanary ? REGION_CANARY_MAX_TARGETS : null;
  return {
    jobId: input.jobId,
    mode: input.mode,
    status: "queued",
    targetKey: buildTargetKey({ ...input, jobId: input.jobId }),
    region: input.region,
    city: input.city?.trim() || null,
    leadId: input.leadId?.trim() || null,
    targetTotal,
    processed: isCanary ? 0 : undefined,
    resumedFrom: isCanary ? null : undefined,
    noResume: isCanary ? true : undefined,
    namespace: isCanary || input.mode === "single" ? getSanitaJobNamespace(input.jobId) : null,
    canaryLeadIds: input.canaryLeadIds,
    canaryLeads: input.canaryLeads,
    forceRescan: input.forceRescan === true,
    skipExistingEvidence: input.skipExistingEvidence === false ? false : undefined,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    lastHeartbeatAt: now,
    lastUpdateLabel: "In attesa",
    resumable: true,
    cancelRequested: false,
    pid: null,
    progress: {
      structuresControlled: 0,
      totalStructures: targetTotal,
      certifiedResults: 0,
      autoVerificationsPending: 0,
      manualChecksNeeded: 0,
      percent: isCanary ? 0 : null,
      currentMessage: "Job in coda.",
      currentStructure: null,
    },
    errorMessage: null,
  } satisfies SanitaJobRecord;
}

export function readSanitaJob(jobId: string) {
  const file = getSanitaJobPath(jobId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as SanitaJobRecord;
}

export function writeSanitaJob(job: SanitaJobRecord) {
  ensureJobsDir();
  job.updatedAt = new Date().toISOString();
  job.lastHeartbeatAt = job.updatedAt;
  const file = getSanitaJobPath(job.jobId);
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
  fs.renameSync(tmp, file);
  return job;
}

export function listSanitaJobs() {
  ensureJobsDir();
  return fs
    .readdirSync(JOBS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(JOBS_DIR, name), "utf8")) as SanitaJobRecord;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => Date.parse(b!.updatedAt) - Date.parse(a!.updatedAt)) as SanitaJobRecord[];
}

export function isActiveSanitaJob(job: SanitaJobRecord) {
  if (job.cancelRequested) return false;
  return job.status === "queued" || job.status === "running";
}

export function findActiveJobByTarget(targetKey: string) {
  return listSanitaJobs().find((job) => job.targetKey === targetKey && isActiveSanitaJob(job)) || null;
}

export function spawnSanitaJobRunner(jobId: string) {
  const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const runner = path.join(process.cwd(), "scripts", "sanita-job-runner.mjs");
  let child;
  try {
    child = spawn(process.execPath, [tsxCli, runner, jobId], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        SCAN_ENGINE_LOCAL: "1",
        VERCEL: process.env.VERCEL ?? "0",
        SANITA_JOB_ID: jobId,
        SANITA_JOB_LEAD_MAX_MS: process.env.SANITA_JOB_LEAD_MAX_MS ?? String(10 * 60_000),
      },
    });
  } catch (err) {
    const current = readSanitaJob(jobId);
    if (current) {
      writeSanitaJob({
        ...current,
        status: "failed",
        finishedAt: new Date().toISOString(),
        resumable: false,
        pid: null,
        lastUpdateLabel: "Errore",
        errorMessage: String(err),
        progress: {
          ...current.progress,
          currentMessage: "Errore durante l'avvio del controllo.",
        },
      });
    }
    return null;
  }
  child.on("error", (err) => {
    try {
      const current = readSanitaJob(jobId);
      if (!current) return;
      writeSanitaJob({
        ...current,
        status: "failed",
        finishedAt: new Date().toISOString(),
        resumable: false,
        pid: null,
        cancelRequested: true,
        lastUpdateLabel: "Errore",
        progress: {
          ...current.progress,
          currentMessage: "Errore durante l'avvio del controllo.",
        },
        errorMessage: String(err),
      });
    } catch {
      /* best-effort */
    }
  });
  child.unref();
  return child.pid ?? null;
}
