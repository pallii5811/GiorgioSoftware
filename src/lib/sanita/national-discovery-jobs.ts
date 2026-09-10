import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ItalianRegion } from "@/lib/sanita/italy-regions";

export type NationalDiscoveryStatus =
  | "queued"
  | "waiting_for_archive"
  | "running"
  | "completed"
  | "incomplete"
  | "cancelled"
  | "failed";

export type NationalDiscoveryJob = {
  jobId: string;
  region: ItalianRegion;
  municipality: string | null;
  status: NationalDiscoveryStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastHeartbeatAt: string | null;
  pid: number | null;
  cancelRequested: boolean;
  errorMessage: string | null;
  progress: {
    municipalitiesCompleted: number;
    municipalitiesTotal: number;
    candidatesFound: number;
    newStructuresAdded: number;
    structuresFound: number;
    structuresScanned: number;
    certifiedResults: number;
    unresolvedResults?: number;
    frontierLeadId?: string;
    frontierState?: string;
    frontierCheckpoint?: string;
    frontierCompleted?: number;
    frontierTotal?: number;
    frontierPending?: number;
    frontierFailed?: number;
    frontierLastProgressAt?: string | null;
    frontierStalled?: boolean;
    currentMunicipality: string | null;
    message: string;
  };
};

function jobsDir() {
  return path.join(process.cwd(), "data", "sanita-national-discovery");
}

export function getNationalDiscoveryJobPath(jobId: string) {
  return path.join(jobsDir(), `${jobId}.json`);
}

export function readNationalDiscoveryJob(jobId: string): NationalDiscoveryJob | null {
  try {
    return JSON.parse(fs.readFileSync(getNationalDiscoveryJobPath(jobId), "utf8"));
  } catch {
    return null;
  }
}

export function writeNationalDiscoveryJob(job: NationalDiscoveryJob) {
  fs.mkdirSync(jobsDir(), { recursive: true });
  job.updatedAt = new Date().toISOString();
  if (job.status === "running" || job.status === "waiting_for_archive") {
    job.lastHeartbeatAt = job.updatedAt;
  }
  const file = getNationalDiscoveryJobPath(job.jobId);
  const temporary = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(job, null, 2));
  fs.renameSync(temporary, file);
  return job;
}

export function createNationalDiscoveryJob(input: {
  region: ItalianRegion;
  municipality?: string | null;
  municipalitiesTotal: number;
}): NationalDiscoveryJob {
  const now = new Date().toISOString();
  return {
    jobId: crypto.randomUUID(),
    region: input.region,
    municipality: input.municipality?.trim() || null,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    lastHeartbeatAt: now,
    pid: null,
    cancelRequested: false,
    errorMessage: null,
    progress: {
      municipalitiesCompleted: 0,
      municipalitiesTotal: input.municipalitiesTotal,
      candidatesFound: 0,
      newStructuresAdded: 0,
      structuresFound: 0,
      structuresScanned: 0,
      certifiedResults: 0,
      currentMunicipality: null,
      message: "Scansione territorio in preparazione.",
    },
  };
}

export function listNationalDiscoveryJobs() {
  fs.mkdirSync(jobsDir(), { recursive: true });
  return fs
    .readdirSync(jobsDir())
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(jobsDir(), name), "utf8")) as NationalDiscoveryJob;
      } catch {
        return null;
      }
    })
    .filter((job): job is NationalDiscoveryJob => Boolean(job))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function findActiveNationalDiscoveryJob(region: ItalianRegion, municipality: string | null) {
  return (
    listNationalDiscoveryJobs().find(
      (job) =>
        job.region === region &&
        job.municipality === municipality &&
        ["queued", "waiting_for_archive", "running"].includes(job.status) &&
        !job.cancelRequested
    ) ?? null
  );
}

export function spawnNationalDiscoveryRunner(jobId: string) {
  const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const runner = path.join(process.cwd(), "scripts", "sanita-national-discovery-runner.mjs");
  const frontierDir =
    process.env.NATIONAL_DISCOVERY_FRONTIER_DIR ||
    path.join("/var", "lib", "leadsniper", "frontiers");
  fs.mkdirSync(frontierDir, { recursive: true });
  const child = spawn(process.execPath, [tsxCli, runner, jobId], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      SCAN_ENGINE_LOCAL: "1",
      NATIONAL_DISCOVERY_JOB_ID: jobId,
      MAPS_CITY_BUDGET_MS: process.env.TERRITORY_MAPS_CITY_BUDGET_MS || "120000",
      FRONTIER_DB_PATH: path.join(frontierDir, `${jobId}.sqlite`),
      SHADOW_RUN_ID: `territory-${jobId}`,
    },
  });
  child.unref();
  return child.pid ?? null;
}

function discoveryProcessGroup(pid: number, jobId: string) {
  if (process.platform !== "linux") return pid;
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    if (
      !cmdline.includes("sanita-national-discovery-runner.mjs") ||
      !cmdline.includes(jobId)
    ) {
      return null;
    }
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const tail = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    const processGroup = Number(tail[2]);
    return Number.isInteger(processGroup) && processGroup > 1 ? processGroup : pid;
  } catch {
    return null;
  }
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalDiscoveryProcess(pid: number, processGroup: number, signal: NodeJS.Signals) {
  try {
    if (process.platform !== "win32" && processGroup > 1) {
      process.kill(-processGroup, signal);
    } else {
      process.kill(pid, signal);
    }
    return;
  } catch {
    /* prova il solo processo */
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* processo gia terminato */
  }
}

export async function cancelNationalDiscoveryJob(job: NationalDiscoveryJob) {
  const requested = writeNationalDiscoveryJob({
    ...job,
    cancelRequested: true,
    progress: {
      ...job.progress,
      message: "Arresto sicuro della scansione in corso.",
    },
  });

  const pid = requested.pid;
  if (pid && processAlive(pid)) {
    const processGroup = discoveryProcessGroup(pid, requested.jobId);
    if (processGroup) {
      signalDiscoveryProcess(pid, processGroup, "SIGTERM");
      const deadline = Date.now() + 3_000;
      while (processAlive(pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (processAlive(pid)) signalDiscoveryProcess(pid, processGroup, "SIGKILL");
    }
  }

  const latest = readNationalDiscoveryJob(requested.jobId) ?? requested;
  return writeNationalDiscoveryJob({
    ...latest,
    status: "cancelled",
    pid: null,
    cancelRequested: true,
    finishedAt: new Date().toISOString(),
    errorMessage: null,
    progress: {
      ...latest.progress,
      currentMunicipality: null,
      message: "Scansione annullata. Checkpoint conservato.",
    },
  });
}
