import { NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  emptySanitaJob,
  findActiveJobByTarget,
  listSanitaJobs,
  REGION_CANARY_MAX_TARGETS,
  spawnSanitaJobRunner,
  writeRegionCanaryCheckpoint,
  writeSanitaJob,
  type SanitaJobMode,
} from "@/lib/sanita/jobs";
import { reconcileStaleSanitaJobs } from "@/lib/sanita/job-watchdog";
import { prisma } from "@/lib/prisma";
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
  maxTargets?: number;
  forceRescan?: boolean;
  skipExistingEvidence?: boolean;
  canaryLeadIds?: string[];
};

function stopShipRegionCanary(job: ReturnType<typeof emptySanitaJob>) {
  const reasons: string[] = [];
  if (job.targetTotal != null && job.targetTotal > REGION_CANARY_MAX_TARGETS) {
    reasons.push(`targetTotal>${REGION_CANARY_MAX_TARGETS}`);
  }
  if ((job.processed ?? 0) > 0) reasons.push("processed>0 at create");
  if (job.resumedFrom != null) reasons.push("resumedFrom not null");
  if (job.progress.totalStructures != null && job.progress.totalStructures > REGION_CANARY_MAX_TARGETS) {
    reasons.push(`totalStructures>${REGION_CANARY_MAX_TARGETS}`);
  }
  if (job.progress.structuresControlled > 0) reasons.push("structuresControlled>0 at create");
  return reasons;
}

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
  reconcileStaleSanitaJobs();
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

  const jobId = crypto.randomUUID();

  let canaryLeadIds: string[] | undefined;
  let canaryLeads: { id: string; companyName: string; city: string | null }[] | undefined;

  if (mode === "region-canary") {
    const maxTargets = Math.min(
      REGION_CANARY_MAX_TARGETS,
      Math.max(1, Number(body.maxTargets || REGION_CANARY_MAX_TARGETS))
    );
    if (maxTargets > REGION_CANARY_MAX_TARGETS) {
      return NextResponse.json(
        { success: false, error: "STOP-SHIP: maxTargets > 3" },
        { status: 400 }
      );
    }
    const pinned = Array.isArray(body.canaryLeadIds)
      ? body.canaryLeadIds.map((id) => String(id).trim()).filter(Boolean)
      : [];
    if (pinned.length) {
      if (pinned.length !== maxTargets) {
        return NextResponse.json(
          { success: false, error: `canaryLeadIds count mismatch (${pinned.length}/${maxTargets})` },
          { status: 400 }
        );
      }
      const rows = await prisma.lead.findMany({
        where: { id: { in: pinned }, type: "HEALTHCARE", region },
        select: { id: true, companyName: true, city: true },
      });
      if (rows.length !== pinned.length) {
        return NextResponse.json({ success: false, error: "canaryLeadIds invalidi" }, { status: 400 });
      }
      const byId = new Map(rows.map((r) => [r.id, r]));
      canaryLeadIds = pinned;
      canaryLeads = pinned.map((id) => {
        const r = byId.get(id)!;
        return { id: r.id, companyName: r.companyName, city: r.city };
      });
    } else {
    const unscanned = await prisma.lead.findMany({
      where: {
        type: "HEALTHCARE",
        region,
        lastScannedAt: null,
        website: { not: null },
      },
      orderBy: [{ city: "asc" }, { createdAt: "asc" }],
      take: maxTargets,
      select: { id: true, companyName: true, city: true },
    });
    let pending = unscanned;
    if (pending.length < maxTargets) {
      const scanned = await prisma.lead.findMany({
        where: {
          type: "HEALTHCARE",
          region,
          lastScannedAt: { not: null },
          website: { not: null },
          id: { notIn: pending.map((l) => l.id) },
        },
        orderBy: [{ lastScannedAt: "asc" }, { city: "asc" }],
        take: maxTargets - pending.length,
        select: { id: true, companyName: true, city: true },
      });
      pending = [...pending, ...scanned];
    }
    if (pending.length < maxTargets) {
      return NextResponse.json(
        { success: false, error: `Lead pending insufficienti (${pending.length}/${maxTargets})` },
        { status: 400 }
      );
    }
    canaryLeadIds = pending.map((l) => l.id);
    canaryLeads = pending.map((l) => ({
      id: l.id,
      companyName: l.companyName,
      city: l.city,
    }));
    }
  }

  const forceRescan =
    body.forceRescan === true || mode === "single" || mode === "region-canary";

  const candidate = emptySanitaJob({
    jobId,
    mode,
    region,
    city: city || null,
    leadId: leadId || null,
    canaryLeadIds,
    canaryLeads,
    forceRescan,
    skipExistingEvidence: body.skipExistingEvidence,
  });

  reconcileStaleSanitaJobs();

  if (mode === "region-canary") {
    const ship = stopShipRegionCanary(candidate);
    if (ship.length) {
      return NextResponse.json(
        { success: false, error: "STOP-SHIP", reasons: ship },
        { status: 400 }
      );
    }
  }

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
  if (mode === "region-canary") writeRegionCanaryCheckpoint(candidate);
  const pid = spawnSanitaJobRunner(candidate.jobId);
  const job = writeSanitaJob({ ...candidate, pid });
  return NextResponse.json({ success: true, created: true, job });
}
