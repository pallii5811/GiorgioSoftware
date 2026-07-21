import { NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  emptySanitaJob,
  findActiveJobByTarget,
  listSanitaJobs,
  spawnSanitaJobRunner,
  writeSanitaJob,
  type SanitaJobMode,
} from "@/lib/sanita/jobs";
import {
  getScanEngineUrl,
  HETZNER_SCAN_ENGINE,
  isVercelUiHost,
} from "@/lib/sanita/scan-engine-url";

export const runtime = "nodejs";
export const maxDuration = 60;

type CreateJobBody = {
  mode?: SanitaJobMode;
  region?: "Veneto" | "Campania";
  city?: string | null;
  leadId?: string | null;
};

async function proxyJobsList(search: string) {
  const bases = [getScanEngineUrl(), HETZNER_SCAN_ENGINE].filter((v, i, a) => v && a.indexOf(v) === i);
  for (const base of bases) {
    try {
      const upstream = await fetch(`${base}/api/sanita/jobs${search}`, { cache: "no-store" });
      if (upstream.ok) return NextResponse.json(await upstream.json());
    } catch {
      /* try next */
    }
  }
  return NextResponse.json(
    { success: false, error: "Motore scansione Hetzner non raggiungibile" },
    { status: 503 }
  );
}

async function proxyJobCreate(body: CreateJobBody) {
  const bases = [getScanEngineUrl(), HETZNER_SCAN_ENGINE].filter((v, i, a) => v && a.indexOf(v) === i);
  for (const base of bases) {
    try {
      const upstream = await fetch(`${base}/api/sanita/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (upstream.ok) return NextResponse.json(await upstream.json());
    } catch {
      /* try next */
    }
  }
  return NextResponse.json(
    { success: false, error: "Motore scansione Hetzner non raggiungibile" },
    { status: 503 }
  );
}

export async function GET(req: Request) {
  if (isVercelUiHost()) {
    const url = new URL(req.url);
    return proxyJobsList(url.search);
  }

  const url = new URL(req.url);
  const onlyActive = url.searchParams.get("active") === "1";
  const limit = Math.max(1, Math.min(20, Number(url.searchParams.get("limit") || 10)));
  let jobs = listSanitaJobs();
  if (onlyActive) jobs = jobs.filter((job) => job.status === "queued" || job.status === "running");
  return NextResponse.json({ success: true, jobs: jobs.slice(0, limit) });
}

export async function POST(req: Request) {
  let body: CreateJobBody;
  try {
    body = (await req.json()) as CreateJobBody;
  } catch {
    return NextResponse.json({ success: false, error: "Richiesta non valida" }, { status: 400 });
  }

  if (isVercelUiHost()) return proxyJobCreate(body);

  const mode = body.mode;
  const region = body.region;
  const city = typeof body.city === "string" ? body.city.trim() : "";
  const leadId = typeof body.leadId === "string" ? body.leadId.trim() : "";

  if (!mode || !region || !["Veneto", "Campania"].includes(region)) {
    return NextResponse.json({ success: false, error: "Parametri job non validi" }, { status: 400 });
  }
  if (mode === "city" && !city) {
    return NextResponse.json({ success: false, error: "Comune mancante" }, { status: 400 });
  }
  if (mode === "single" && !leadId) {
    return NextResponse.json({ success: false, error: "Struttura mancante" }, { status: 400 });
  }

  const candidate = emptySanitaJob({
    jobId: crypto.randomUUID(),
    mode,
    region,
    city: city || null,
    leadId: leadId || null,
  });
  const existing = findActiveJobByTarget(candidate.targetKey);
  if (existing) {
    if (existing.status === "queued" && !existing.pid && !existing.cancelRequested) {
      const pid = spawnSanitaJobRunner(existing.jobId);
      const job = writeSanitaJob({ ...existing, pid });
      return NextResponse.json({ success: true, created: false, respawned: true, job });
    }
    return NextResponse.json({ success: true, created: false, job: existing });
  }

  // Runner legge il file all'avvio — scrivere prima dello spawn.
  writeSanitaJob(candidate);
  const pid = spawnSanitaJobRunner(candidate.jobId);
  const job = writeSanitaJob({ ...candidate, pid });
  return NextResponse.json({ success: true, created: true, job });
}
