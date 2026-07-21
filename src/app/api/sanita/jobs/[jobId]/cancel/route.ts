import { NextResponse } from "next/server";
import {
  readSanitaJob,
  writeSanitaJob,
} from "@/lib/sanita/jobs";
import { killProcessTree } from "@/lib/sanita/job-watchdog";
import {
  getScanEngineUrl,
  HETZNER_SCAN_ENGINE,
  isVercelUiHost,
} from "@/lib/sanita/scan-engine-url";

export const runtime = "nodejs";
export const maxDuration = 60;

async function proxyJobCancel(jobId: string) {
  const bases = [getScanEngineUrl(), HETZNER_SCAN_ENGINE].filter((v, i, a) => v && a.indexOf(v) === i);
  for (const base of bases) {
    try {
      const upstream = await fetch(`${base}/api/sanita/jobs/${jobId}/cancel`, {
        method: "POST",
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

export async function POST(_req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await ctx.params;
  if (isVercelUiHost()) return proxyJobCancel(jobId);

  const job = readSanitaJob(jobId);
  if (!job) {
    return NextResponse.json({ success: false, error: "Job non trovato" }, { status: 404 });
  }
  let next = writeSanitaJob({
    ...job,
    cancelRequested: true,
    lastUpdateLabel: "Interruzione richiesta",
    progress: {
      ...job.progress,
      currentMessage: "Interruzione richiesta. Il job si fermera' in sicurezza.",
    },
  });
  if (next.pid) {
    killProcessTree(next.pid);
  }
  next = writeSanitaJob({
    ...next,
    status: "cancelled",
    finishedAt: new Date().toISOString(),
    resumable: false,
    pid: null,
    cancelRequested: true,
    lastUpdateLabel: "Interrotto",
    progress: {
      ...next.progress,
      currentMessage: "Controllo interrotto.",
    },
  });
  return NextResponse.json({ success: true, job: next });
}
