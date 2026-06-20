import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { serializeLeadForClient } from "@/lib/sanita/lead-serialize";
import {
  getScanEngineUrl,
  HETZNER_SCAN_ENGINE,
  isVercelUiHost,
} from "@/lib/sanita/scan-engine-url";

export const runtime = "nodejs";
export const maxDuration = 300;

async function proxyRescanToEngine(id: string, website?: string): Promise<Response | null> {
  const bases = [getScanEngineUrl(), HETZNER_SCAN_ENGINE].filter(
    (v, i, a) => v && a.indexOf(v) === i
  );
  for (const base of bases) {
    try {
      const upstream = await fetch(`${base}/api/sanita/rescan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...(website ? { website } : {}) }),
      });
      if (upstream.ok) return upstream;
    } catch {
      /* try next */
    }
  }
  return null;
}

export async function POST(req: Request) {
  let body: { id?: string; website?: string };
  try {
    body = (await req.json()) as { id?: string; website?: string };
  } catch {
    return NextResponse.json({ success: false, error: "Richiesta non valida" }, { status: 400 });
  }

  const id = body.id?.trim();
  if (!id) {
    return NextResponse.json({ success: false, error: "id mancante" }, { status: 400 });
  }

  const websiteIn = typeof body.website === "string" ? body.website.trim() : "";

  if (isVercelUiHost()) {
    const proxied = await proxyRescanToEngine(id, websiteIn || undefined);
    if (!proxied) {
      return NextResponse.json(
        { success: false, error: "Motore scansione Hetzner non raggiungibile" },
        { status: 503 }
      );
    }
    return NextResponse.json(await proxied.json());
  }

  const lead = await prisma.lead.findUnique({ where: { id } });
  if (!lead || lead.type !== "HEALTHCARE") {
    return NextResponse.json({ success: false, error: "Lead non trovato" }, { status: 404 });
  }

  const { analyzeLead } = await import("@/lib/sanita/scan-engine");
  const { terminateOcrWorker } = await import("@/lib/sanita/ocr");
  const { closeMapsBrowserPool } = await import("@/lib/sanita/playwright-maps");

  try {
    const { normalizeWebsite } = await import("@/lib/sanita/discovery");
    const resetData = {
      lastScannedAt: null,
      evidence: null,
      policyFound: false,
      policyCompany: null,
      policyMassimale: null,
      policyNumber: null,
      policyExpiry: null,
      confidence: null,
      websiteReachable: null,
      pagesVisited: 0,
      leadScore: 0,
      ...(websiteIn ? { website: normalizeWebsite(websiteIn) ?? websiteIn } : {}),
    };
    await prisma.lead.update({
      where: { id },
      data: resetData,
    });

    const freshLead = await prisma.lead.findUnique({ where: { id } });
    if (!freshLead) {
      return NextResponse.json({ success: false, error: "Lead non trovato" }, { status: 404 });
    }

    const counters = { analyzed: 0, withPolicy: 0, hot: 0, review: 0 };
    await analyzeLead(freshLead, counters);
    const fresh = await prisma.lead.findUnique({ where: { id } });
    if (!fresh) {
      return NextResponse.json({ success: false, error: "Lead non trovato dopo scansione" }, { status: 500 });
    }
    return NextResponse.json({ success: true, lead: serializeLeadForClient(fresh) });
  } finally {
    await terminateOcrWorker().catch(() => {});
    await closeMapsBrowserPool().catch(() => {});
  }
}
