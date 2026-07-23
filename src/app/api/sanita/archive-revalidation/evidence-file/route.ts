import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import {
  getScanEngineUrl,
  HETZNER_SCAN_ENGINE,
  isScanEngineHost,
  isVercelUiHost,
} from "@/lib/sanita/scan-engine-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EVIDENCE_DIR =
  process.env.REVALIDATE_EVIDENCE_DIR?.trim() ||
  "/opt/leadsniper-revalidate/data/revalidation/evidence-blobs";

function localFile(sha: string): string | null {
  const safe = sha.toLowerCase().replace(/[^a-f0-9]/g, "");
  if (safe.length !== 64) return null;
  const p = path.join(EVIDENCE_DIR, `${safe}.pdf`);
  return fs.existsSync(p) ? p : null;
}

async function proxyUpstream(req: NextRequest) {
  const bases = [getScanEngineUrl(), HETZNER_SCAN_ENGINE].filter(
    (v, i, a) => v && a.indexOf(v) === i
  );
  const qs = req.nextUrl.search || "";
  for (const base of bases) {
    try {
      const upstream = await fetch(
        `${base}/api/sanita/archive-revalidation/evidence-file${qs}`,
        { cache: "no-store" }
      );
      if (!upstream.ok) continue;
      const buf = Buffer.from(await upstream.arrayBuffer());
      return new NextResponse(buf, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": upstream.headers.get("Content-Disposition") || "inline",
          "Cache-Control": "private, max-age=3600",
        },
      });
    } catch {
      /* try next */
    }
  }
  return NextResponse.json({ success: false, error: "Evidence non raggiungibile" }, { status: 404 });
}

export async function GET(req: NextRequest) {
  if (isVercelUiHost()) return proxyUpstream(req);
  const sha = (req.nextUrl.searchParams.get("sha") || "").trim();
  const file = localFile(sha);
  if (!file) {
    if (getScanEngineUrl() || process.env.SCAN_ENGINE_URL) return proxyUpstream(req);
    return NextResponse.json({ success: false, error: "Evidence non trovata" }, { status: 404 });
  }
  if (!isScanEngineHost() && !fs.existsSync(EVIDENCE_DIR)) {
    return proxyUpstream(req);
  }
  const buf = fs.readFileSync(file);
  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="evidence-${sha.slice(0, 12)}.pdf"`,
      "Cache-Control": "private, max-age=3600",
      "X-Evidence-Sha256": sha.toLowerCase(),
    },
  });
}
