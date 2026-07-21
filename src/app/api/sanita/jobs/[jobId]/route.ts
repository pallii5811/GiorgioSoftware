import { NextResponse } from "next/server";
import { readSanitaJob } from "@/lib/sanita/jobs";
import { reconcileStaleSanitaJobs, ensureSanitaJobWatchdog } from "@/lib/sanita/job-watchdog";
import {
  getScanEngineUrl,
  HETZNER_SCAN_ENGINE,
  isVercelUiHost,
} from "@/lib/sanita/scan-engine-url";

export const runtime = "nodejs";
export const maxDuration = 60;

async function proxyJobGet(jobId: string) {
  const bases = [getScanEngineUrl(), HETZNER_SCAN_ENGINE].filter((v, i, a) => v && a.indexOf(v) === i);
  for (const base of bases) {
    try {
      const upstream = await fetch(`${base}/api/sanita/jobs/${jobId}`, { cache: "no-store" });
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

export async function GET(_req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await ctx.params;
  if (isVercelUiHost()) return proxyJobGet(jobId);
  ensureSanitaJobWatchdog();
  reconcileStaleSanitaJobs();
  const job = readSanitaJob(jobId);
  if (!job) {
    return NextResponse.json({ success: false, error: "Job non trovato" }, { status: 404 });
  }
  return NextResponse.json({ success: true, job });
}
