import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { isProcessAlive, killProcessTree } from "@/lib/sanita/job-watchdog";
import { isVercelUiHost } from "@/lib/sanita/scan-engine-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IS_WINDOWS = process.platform === "win32";

/** Root dell'app che ospita lo script motore (Hetzner: /opt/leadsniper-revalidate/app). */
const APP_ROOT = IS_WINDOWS ? process.cwd() : "/opt/leadsniper-revalidate/app";

/** Root dati del motore (checkpoint, frontiers, shadow db). */
const ENGINE_DATA_ROOT = IS_WINDOWS
  ? path.join(process.cwd(), "data", "revalidation")
  : "/opt/leadsniper-revalidate/data/revalidation";

/** Stato job lato UI: sempre dentro il cwd del server Next. */
const JOB_FILE = path.join(process.cwd(), "data", "sanita-revalidation-job.json");

const CHECKPOINT_PATH =
  process.env.REVALIDATE_CHECKPOINT?.trim() ||
  path.join(ENGINE_DATA_ROOT, "checkpoint.json");

const TARGET_TOTAL_DEFAULT = 877;

type JobStatus = "idle" | "running" | "paused" | "finished" | "failed";

type RevalidationJob = {
  jobId: string;
  pid: number | null;
  status: JobStatus;
  startedAt: string | null;
  finishedAt: string | null;
  targetTotal: number;
  mode: "start" | "resume" | "retry-incomplete";
};

type ControlAction = "start" | "pause" | "resume" | "retry-incomplete";

function readJob(): RevalidationJob | null {
  try {
    const raw = fs.readFileSync(JOB_FILE, "utf8");
    const j = JSON.parse(raw) as RevalidationJob;
    if (!j || typeof j.jobId !== "string") return null;
    return j;
  } catch {
    return null;
  }
}

function writeJob(job: RevalidationJob) {
  fs.mkdirSync(path.dirname(JOB_FILE), { recursive: true });
  const tmp = `${JOB_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
  fs.renameSync(tmp, JOB_FILE);
}

function isJobActive(job: RevalidationJob | null): boolean {
  return Boolean(
    job && job.status === "running" && job.pid && isProcessAlive(job.pid)
  );
}

/** Rileva un motore già attivo fuori dal job file UI (micro-canary / systemd / CLI). */
function findExternalEnginePids(): number[] {
  if (IS_WINDOWS) return [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execSync("pgrep -f '[p]roduction-revalidate-sanita-v3.mjs' || true", {
      encoding: "utf8",
      timeout: 3000,
    });
    return out
      .split(/\s+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 1);
  } catch {
    return [];
  }
}

function isEngineBusy(job: RevalidationJob | null): boolean {
  if (isJobActive(job)) return true;
  return findExternalEnginePids().length > 0;
}

function readCheckpointMeta() {
  try {
    const raw = fs.readFileSync(CHECKPOINT_PATH, "utf8");
    const cp = JSON.parse(raw) as {
      retryQueue?: Record<string, unknown>;
      targetTotal?: number;
      total?: number;
      updatedAt?: string;
    };
    return {
      exists: true,
      retryIds: Object.keys(cp.retryQueue || {}),
      targetTotal: Number(cp.targetTotal || cp.total || TARGET_TOTAL_DEFAULT) || TARGET_TOTAL_DEFAULT,
      updatedAt: cp.updatedAt || null,
    };
  } catch {
    return { exists: false, retryIds: [] as string[], targetTotal: TARGET_TOTAL_DEFAULT, updatedAt: null };
  }
}

function engineEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const base: Record<string, string> = {
    TOTAL_WORKERS: "1",
    REVALIDATE_CONCURRENCY: "1",
    REVALIDATE_DUAL_HOT: "1",
    OCR_ENABLED: "1",
    POLICY_EXHAUSTIVE: "1",
    SCAN_FAST: "0",
    REVALIDATE_CHECKPOINT: CHECKPOINT_PATH,
    REVALIDATE_OUT_DIR: ENGINE_DATA_ROOT,
    FRONTIER_DB_PATH: path.join(ENGINE_DATA_ROOT, "frontiers", "boot.sqlite"),
    NODE_OPTIONS: "--max-old-space-size=3072",
  };
  if (IS_WINDOWS) {
    if (process.env.DATABASE_URL) base.DATABASE_URL = process.env.DATABASE_URL;
    if (process.env.PDFTOPPM_PATH) base.PDFTOPPM_PATH = process.env.PDFTOPPM_PATH;
  } else {
    base.PDFTOPPM_PATH = "/usr/bin/pdftoppm";
    base.DATABASE_URL = "file:/opt/leadsniper-revalidate/shadow-revalidate.db";
  }
  return { ...process.env, ...base, ...extra };
}

function spawnEngine(mode: RevalidationJob["mode"], extraEnv: Record<string, string>): number {
  const child = spawn(
    IS_WINDOWS ? "npx.cmd" : "npx",
    ["tsx", "scripts/production-revalidate-sanita-v3.mjs"],
    {
      cwd: APP_ROOT,
      env: engineEnv(extraEnv),
      detached: !IS_WINDOWS,
      stdio: "ignore",
      windowsHide: true,
    }
  );
  child.unref();
  if (!child.pid) throw new Error("spawn motore fallito: nessun pid");
  return child.pid;
}

function startLike(mode: "start" | "resume" | "retry-incomplete") {
  const current = readJob();
  if (isEngineBusy(current)) {
    return NextResponse.json(
      {
        success: false,
        error: "Job già in esecuzione",
        job: current,
        externalPids: findExternalEnginePids(),
      },
      { status: 409 }
    );
  }

  const cp = readCheckpointMeta();
  const extraEnv: Record<string, string> = {};
  if (mode === "retry-incomplete") {
    if (cp.retryIds.length === 0) {
      return NextResponse.json(
        { success: false, error: "Nessun lead in retryQueue" },
        { status: 400 }
      );
    }
    extraEnv.REVALIDATE_IDS = cp.retryIds.join(",");
  } else {
    // REVALIDATE_IDS vuoto = tutti; il resume avviene dal checkpoint esistente.
    extraEnv.REVALIDATE_IDS = "";
  }

  let pid: number;
  try {
    pid = spawnEngine(mode, extraEnv);
  } catch (e) {
    return NextResponse.json(
      { success: false, error: `Avvio motore fallito: ${String(e)}` },
      { status: 500 }
    );
  }

  const job: RevalidationJob = {
    jobId: `reval-${Date.now().toString(36)}`,
    pid,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    targetTotal: cp.targetTotal,
    mode,
  };
  writeJob(job);
  return NextResponse.json({ success: true, job });
}

export async function POST(req: Request) {
  if (isVercelUiHost()) {
    return NextResponse.json(
      { success: false, error: "Motore non raggiungibile" },
      { status: 503 }
    );
  }

  let action: ControlAction;
  try {
    const body = (await req.json()) as { action?: string };
    action = body.action as ControlAction;
  } catch {
    return NextResponse.json({ success: false, error: "JSON non valido" }, { status: 400 });
  }
  if (!["start", "pause", "resume", "retry-incomplete"].includes(action)) {
    return NextResponse.json(
      { success: false, error: "Azione non valida" },
      { status: 400 }
    );
  }

  if (action === "start" || action === "resume") return startLike(action);
  if (action === "retry-incomplete") return startLike("retry-incomplete");

  // pause — ferma job UI e/o motore esterno (CLI / micro-canary / systemd oneshot)
  const job = readJob();
  const external = findExternalEnginePids();
  if ((!job || job.status !== "running") && external.length === 0) {
    return NextResponse.json(
      { success: false, error: "Nessun job in esecuzione", job },
      { status: 409 }
    );
  }
  if (job?.pid) killProcessTree(job.pid);
  for (const pid of external) {
    try {
      killProcessTree(pid);
    } catch {
      /* ignore */
    }
  }
  const paused: RevalidationJob = {
    jobId: job?.jobId || `reval-ext-${Date.now().toString(36)}`,
    pid: null,
    status: "paused",
    startedAt: job?.startedAt || null,
    finishedAt: new Date().toISOString(),
    targetTotal: job?.targetTotal || TARGET_TOTAL_DEFAULT,
    mode: job?.mode || "start",
  };
  writeJob(paused);
  return NextResponse.json({ success: true, job: paused, killedExternalPids: external });
}

export async function GET() {
  if (isVercelUiHost()) {
    return NextResponse.json(
      { success: false, error: "Motore non raggiungibile" },
      { status: 503 }
    );
  }
  const job = readJob();
  // riconcilia: job marcato running ma processo morto → failed
  if (job && job.status === "running" && (!job.pid || !isProcessAlive(job.pid))) {
    job.status = "failed";
    job.pid = null;
    job.finishedAt = job.finishedAt || new Date().toISOString();
    writeJob(job);
  }
  const externalPids = findExternalEnginePids();
  const cp = readCheckpointMeta();
  return NextResponse.json({
    success: true,
    job,
    active: isJobActive(job) || externalPids.length > 0,
    externalPids,
    checkpointExists: cp.exists,
    checkpointUpdatedAt: cp.updatedAt,
    retryQueueCount: cp.retryIds.length,
    targetTotal: cp.targetTotal,
  });
}
