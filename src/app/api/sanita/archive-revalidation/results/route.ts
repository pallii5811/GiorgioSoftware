import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import {
  getScanEngineUrl,
  HETZNER_SCAN_ENGINE,
  isScanEngineHost,
  isVercelUiHost,
} from "@/lib/sanita/scan-engine-url";
import {
  applyFilters,
  inRunScope,
  mapCheckpointOnly,
  mapResultRow,
  sortResults,
  type CheckpointRetry,
  type CheckpointTerminal,
  type ShadowResultRow,
} from "@/lib/sanita/archive-results-map";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHECKPOINT_PATH =
  process.env.REVALIDATE_CHECKPOINT?.trim() ||
  "/opt/leadsniper-revalidate/data/revalidation/checkpoint.json";
const OUT_DIR =
  process.env.REVALIDATE_OUT_DIR?.trim() ||
  "/opt/leadsniper-revalidate/data/revalidation";
const RESULTS_DIR = path.join(OUT_DIR, "results");
const CURRENT_RUN_PATH = path.join(OUT_DIR, "current-run.json");

type CheckpointFile = {
  startedAt?: string;
  updatedAt?: string;
  terminal?: Record<string, CheckpointTerminal>;
  retryQueue?: Record<string, CheckpointRetry>;
  inProgress?: Record<string, unknown>;
};

function readJsonSafe<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

function readLocalResults(req: NextRequest) {
  const cp = readJsonSafe<CheckpointFile>(CHECKPOINT_PATH);
  if (!cp) {
    return NextResponse.json(
      {
        success: false,
        error: "checkpoint non leggibile",
        results: [],
        meta: { runStartedAt: null, runLabel: null, checkpointUpdatedAt: null, total: 0, runTotal: 0 },
      },
      { status: 503 }
    );
  }

  const currentRun = readJsonSafe<{ startedAt?: string; label?: string }>(CURRENT_RUN_PATH);
  const runStartedAt = currentRun?.startedAt || cp.startedAt || null;
  const runLabel = currentRun?.label || null;

  const sp = req.nextUrl.searchParams;
  const scopeRaw = sp.get("scope");
  const scope =
    scopeRaw === "all" || scopeRaw === "working" ? scopeRaw : "run";
  const limit = Math.min(2000, Math.max(1, Number(sp.get("limit")) || 500));
  const filter = {
    region: sp.get("region"),
    outcome: sp.get("outcome"),
    city: sp.get("city"),
    q: sp.get("q"),
  };

  const ids = new Set<string>(
    scope === "working"
      ? [...Object.keys(cp.retryQueue || {}), ...Object.keys(cp.inProgress || {})]
      : [
          ...Object.keys(cp.terminal || {}),
          ...Object.keys(cp.retryQueue || {}),
          ...Object.keys(cp.inProgress || {}),
        ]
  );

  const rows: ShadowResultRow[] = [];
  for (const id of ids) {
    const row = readJsonSafe<Record<string, unknown>>(path.join(RESULTS_DIR, `${id}.json`));
    if (row && typeof row.id === "string") {
      rows.push(mapResultRow(row));
    } else {
      rows.push(mapCheckpointOnly(id, cp.terminal?.[id], cp.retryQueue?.[id]));
    }
  }

  const runTotal = rows.filter((r) => inRunScope(r.completedAt, runStartedAt)).length;
  let out =
    scope === "run"
      ? rows.filter((r) => inRunScope(r.completedAt, runStartedAt))
      : scope === "working"
        ? rows
        : rows;
  out = applyFilters(out, filter);
  out = sortResults(out).slice(0, limit);

  return NextResponse.json({
    success: true,
    results: out,
    meta: {
      runStartedAt,
      runLabel,
      checkpointUpdatedAt: cp.updatedAt || null,
      total: out.length,
      runTotal,
    },
  });
}

async function proxyUpstream(req: NextRequest) {
  const bases = [getScanEngineUrl(), HETZNER_SCAN_ENGINE].filter(
    (v, i, a) => v && a.indexOf(v) === i
  );
  const qs = req.nextUrl.search || "";
  for (const base of bases) {
    try {
      const upstream = await fetch(`${base}/api/sanita/archive-revalidation/results${qs}`, {
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
      error: "Motore non raggiungibile",
      results: [],
      meta: { runStartedAt: null, runLabel: null, checkpointUpdatedAt: null, total: 0, runTotal: 0 },
    },
    { status: 503 }
  );
}

export async function GET(req: NextRequest) {
  if (isVercelUiHost()) return proxyUpstream(req);
  if (isScanEngineHost() || fs.existsSync(CHECKPOINT_PATH)) {
    return readLocalResults(req);
  }
  if (getScanEngineUrl() || process.env.SCAN_ENGINE_URL) {
    return proxyUpstream(req);
  }
  return NextResponse.json({
    success: true,
    results: [],
    meta: { runStartedAt: null, runLabel: null, checkpointUpdatedAt: null, total: 0, runTotal: 0 },
  });
}
