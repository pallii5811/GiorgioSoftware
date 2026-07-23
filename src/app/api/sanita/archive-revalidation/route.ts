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

type TerminalEntry = {
  processingState?: string | null;
  state?: string | null;
};

type CheckpointFile = {
  stats?: {
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
  terminal?: Record<string, TerminalEntry | string>;
  inProgress?: Record<string, unknown>;
  retryQueue?: Record<string, unknown>;
  updatedAt?: string;
  targetTotal?: number;
  total?: number;
};

/** Current-state snapshot per lead — never use cumulative stats.retry/tech for UI. */
function deriveCurrentState(cp: CheckpointFile) {
  const terminal = cp.terminal || {};
  const inProgress = cp.inProgress || {};
  const retryQueue = cp.retryQueue || {};

  let reviewCurrent = 0;
  let technicalBlockedFinal = 0;
  let hot = 0;
  let published = 0;
  let selfInsurance = 0;
  let otherNonCommercialTerminal = 0;
  let outOfScope = 0;
  const terminalIds = {
    hot: [] as string[],
    published: [] as string[],
    selfInsurance: [] as string[],
    review: [] as string[],
    technical: [] as string[],
    other: [] as string[],
  };

  for (const [lid, raw] of Object.entries(terminal)) {
    const ps =
      typeof raw === "string"
        ? raw
        : String(raw?.processingState || raw?.state || "").toUpperCase();
    if (ps === "REVIEW_HUMAN") {
      reviewCurrent++;
      terminalIds.review.push(lid);
    } else if (ps === "TECHNICAL_BLOCKED") {
      technicalBlockedFinal++;
      terminalIds.technical.push(lid);
    } else if (ps === "HOT_VERIFIED") {
      hot++;
      terminalIds.hot.push(lid);
    } else if (ps === "SELF_INSURANCE_VERIFIED") {
      selfInsurance++;
      terminalIds.selfInsurance.push(lid);
    } else if (
      ps === "PUBLISHED_CURRENT" ||
      ps === "PUBLISHED_EXPIRED" ||
      ps === "PUBLISHED_DATE_UNKNOWN"
    ) {
      published++;
      terminalIds.published.push(lid);
    } else if (ps === "OUT_OF_SCOPE") {
      outOfScope++;
      otherNonCommercialTerminal++;
      terminalIds.other.push(lid);
    } else if (ps.startsWith("PUBLISHED") || ps) {
      // ANALOGOUS / INCOMPLETE / STALE / altri terminali non commerciali
      otherNonCommercialTerminal++;
      terminalIds.other.push(lid);
    }
  }

  // Conteggi verificabili: certified + review + other + technical = terminalCompleted
  const certifiedCurrentRun = published + hot + selfInsurance;
  const terminalCompleted =
    certifiedCurrentRun + reviewCurrent + otherNonCommercialTerminal + technicalBlockedFinal;
  const currentlyInProgress = Object.keys(inProgress).length;
  const currentRetryQueue = Object.keys(retryQueue).length;
  const recordsTouched = Number(cp.stats?.processed || 0);

  return {
    recordsTouched,
    terminalCompleted,
    currentlyInProgress,
    currentRetryQueue,
    reviewCurrent,
    technicalBlockedFinal,
    certifiedCurrentRun,
    hot,
    published,
    selfInsurance,
    otherNonCommercialTerminal,
    outOfScope,
    terminalIds,
  };
}

function emptyPayload(extra: Record<string, unknown> = {}) {
  return {
    success: true,
    available: false,
    active: false,
    statusLabel: "Non disponibile",
    targetTotal: TARGET_TOTAL_DEFAULT,
    updatedAt: null as string | null,
    // legacy aliases kept for older clients
    processed: 0,
    terminal: 0,
    percent: 0,
    certifiedResults: 0,
    checksNeeded: 0,
    technicalPending: 0,
    absenceFound: 0,
    // current-state
    recordsTouched: 0,
    terminalCompleted: 0,
    currentlyInProgress: 0,
    currentRetryQueue: 0,
    reviewCurrent: 0,
    technicalBlockedFinal: 0,
    certifiedCurrentRun: 0,
    hot: 0,
    published: 0,
    selfInsurance: 0,
    otherNonCommercialTerminal: 0,
    terminalIds: { hot: [], published: [], selfInsurance: [], review: [], technical: [], other: [] },
    ...extra,
  };
}

async function readLocalStatus() {
  let readable = false;
  let cp: CheckpointFile = {};
  let updatedAt: string | null = null;

  try {
    const raw = await fs.promises.readFile(CHECKPOINT_PATH, "utf8");
    cp = JSON.parse(raw) as CheckpointFile;
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

  const targetTotal = Number(cp.targetTotal || cp.total || TARGET_TOTAL_DEFAULT) || TARGET_TOTAL_DEFAULT;
  const cur = readable
    ? deriveCurrentState(cp)
    : {
        recordsTouched: 0,
        terminalCompleted: 0,
        currentlyInProgress: 0,
        currentRetryQueue: 0,
        reviewCurrent: 0,
        technicalBlockedFinal: 0,
        certifiedCurrentRun: 0,
        hot: 0,
        published: 0,
        selfInsurance: 0,
        otherNonCommercialTerminal: 0,
        outOfScope: 0,
        terminalIds: {
          hot: [],
          published: [],
          selfInsurance: [],
          review: [],
          technical: [],
          other: [],
        },
      };

  const percent =
    targetTotal > 0
      ? Math.min(100, Math.round((cur.terminalCompleted / targetTotal) * 1000) / 10)
      : 0;

  return {
    success: true,
    available: readable,
    active,
    statusLabel: active ? "Verifica in corso" : readable ? "In pausa" : "Non disponibile",
    targetTotal,
    percent,
    updatedAt,
    // current-state (authoritative for UI)
    recordsTouched: cur.recordsTouched,
    terminalCompleted: cur.terminalCompleted,
    currentlyInProgress: cur.currentlyInProgress,
    currentRetryQueue: cur.currentRetryQueue,
    reviewCurrent: cur.reviewCurrent,
    technicalBlockedFinal: cur.technicalBlockedFinal,
    certifiedCurrentRun: cur.certifiedCurrentRun,
    hot: cur.hot,
    published: cur.published,
    selfInsurance: cur.selfInsurance,
    otherNonCommercialTerminal: cur.otherNonCommercialTerminal,
    terminalIds: cur.terminalIds ?? {
      hot: [],
      published: [],
      selfInsurance: [],
      review: [],
      technical: [],
      other: [],
    },
    // aliases for existing UI fields during rollout
    processed: cur.recordsTouched,
    terminal: cur.terminalCompleted,
    certifiedResults: cur.certifiedCurrentRun,
    checksNeeded: cur.reviewCurrent,
    /** @deprecated do not use — was cumulative retry+tech */
    technicalPending: cur.technicalBlockedFinal,
    absenceFound: cur.hot,
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
    { ...emptyPayload({ success: false, statusLabel: "Non raggiungibile", error: "Motore non raggiungibile" }) },
    { status: 503 }
  );
}

export async function GET() {
  if (isVercelUiHost()) return proxyUpstream();
  if (isScanEngineHost() || fs.existsSync(CHECKPOINT_PATH)) {
    return NextResponse.json(await readLocalStatus());
  }
  if (getScanEngineUrl() || process.env.SCAN_ENGINE_URL) {
    return proxyUpstream();
  }
  return NextResponse.json(emptyPayload({ statusLabel: "Non disponibile in locale" }));
}
