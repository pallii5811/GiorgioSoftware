import { NextResponse } from "next/server";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  getScanEngineUrl,
  HETZNER_SCAN_ENGINE,
  isScanEngineHost,
  isVercelUiHost,
} from "@/lib/sanita/scan-engine-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

const CHECKPOINT_PATH =
  process.env.REVALIDATE_CHECKPOINT?.trim() ||
  "/opt/leadsniper-revalidate/data/revalidation/checkpoint.json";

const TARGET_TOTAL_DEFAULT = 877;

type CheckpointStats = {
  processed?: number;
  terminal?: number;
  hot?: number;
  pub?: number;
  review?: number;
  retry?: number;
  tech?: number;
  outOfScope?: number;
  errors?: number;
};

async function readLocalStatus() {
  let processed = 0;
  let targetTotal = TARGET_TOTAL_DEFAULT;
  let stats: CheckpointStats = {};
  let updatedAt: string | null = null;
  let readable = false;

  try {
    const raw = await fs.promises.readFile(CHECKPOINT_PATH, "utf8");
    const cp = JSON.parse(raw) as {
      stats?: CheckpointStats;
      updatedAt?: string;
      targetTotal?: number;
      total?: number;
    };
    stats = cp.stats || {};
    processed = Number(stats.processed || 0);
    targetTotal = Number(cp.targetTotal || cp.total || TARGET_TOTAL_DEFAULT) || TARGET_TOTAL_DEFAULT;
    updatedAt = cp.updatedAt || null;
    try {
      const st = await fs.promises.stat(CHECKPOINT_PATH);
      updatedAt = updatedAt || st.mtime.toISOString();
    } catch {
      /* keep */
    }
    readable = true;
  } catch {
    readable = false;
  }

  let active = false;
  try {
    const { stdout } = await execFileAsync("systemctl", ["is-active", "giorgio-revalidate"], {
      timeout: 3000,
    });
    active = String(stdout).trim() === "active";
  } catch {
    active = false;
  }

  const pct =
    targetTotal > 0 ? Math.min(100, Math.round((processed / targetTotal) * 1000) / 10) : 0;

  return {
    success: true,
    available: readable,
    active,
    statusLabel: active ? "Verifica in corso" : readable ? "In pausa" : "Non disponibile",
    processed,
    targetTotal,
    percent: pct,
    updatedAt,
    /** Client-safe aggregates — no internal token names. */
    certifiedResults: Number(stats.pub || 0),
    checksNeeded: Number(stats.review || 0),
    technicalPending: Number(stats.retry || 0) + Number(stats.tech || 0),
    absenceFound: Number(stats.hot || 0),
    terminal: Number(stats.terminal || 0),
  };
}

async function proxyUpstream() {
  const bases = [getScanEngineUrl(), HETZNER_SCAN_ENGINE].filter(
    (v, i, a) => v && a.indexOf(v) === i
  );
  for (const base of bases) {
    try {
      const upstream = await fetch(`${base}/api/sanita/archive-revalidation`, {
        cache: "no-store",
      });
      if (upstream.ok) return NextResponse.json(await upstream.json());
    } catch {
      /* try next */
    }
  }
  return NextResponse.json(
    {
      success: false,
      available: false,
      active: false,
      statusLabel: "Non raggiungibile",
      processed: 0,
      targetTotal: TARGET_TOTAL_DEFAULT,
      percent: 0,
      updatedAt: null,
      certifiedResults: 0,
      checksNeeded: 0,
      technicalPending: 0,
      absenceFound: 0,
      terminal: 0,
      error: "Motore non raggiungibile",
    },
    { status: 503 }
  );
}

export async function GET() {
  if (isVercelUiHost()) return proxyUpstream();
  // Hetzner / local engine host: read checkpoint if present
  if (isScanEngineHost() || fs.existsSync(CHECKPOINT_PATH)) {
    return NextResponse.json(await readLocalStatus());
  }
  // Local dev without checkpoint — try proxy, else empty
  if (getScanEngineUrl() || process.env.SCAN_ENGINE_URL) {
    return proxyUpstream();
  }
  return NextResponse.json({
    success: true,
    available: false,
    active: false,
    statusLabel: "Non disponibile in locale",
    processed: 0,
    targetTotal: TARGET_TOTAL_DEFAULT,
    percent: 0,
    updatedAt: null,
    certifiedResults: 0,
    checksNeeded: 0,
    technicalPending: 0,
    absenceFound: 0,
    terminal: 0,
  });
}
