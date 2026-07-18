import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getScanEngineUrl,
  HETZNER_SCAN_ENGINE,
  isVercelUiHost,
} from "@/lib/sanita/scan-engine-url";
import { isFreshTenderLead, parseTenderAwardDateObj } from "@/lib/gare/display";

export const runtime = "nodejs";
export const maxDuration = 300;

async function proxyToEngine(
  req: Request,
  path = "/api/gare",
  opts: { timeoutMs?: number; body?: string } = {}
): Promise<NextResponse | null> {
  const bases = [getScanEngineUrl(), HETZNER_SCAN_ENGINE].filter(
    (v, i, a) => v && a.indexOf(v) === i
  );
  const url = new URL(req.url);
  const timeoutMs = opts.timeoutMs ?? 25_000;
  for (const base of bases) {
    try {
      const init: RequestInit = {
        method: req.method,
        cache: "no-store",
        headers: { "Content-Type": req.headers.get("Content-Type") ?? "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      };
      if (req.method !== "GET" && req.method !== "HEAD" && opts.body !== undefined) {
        init.body = opts.body;
      }
      const upstream = await fetch(`${base}${path}${url.search}`, init);
      if (!upstream.ok) continue;
      const body = await upstream.text();
      if (!body.trim()) continue;
      try {
        const parsed = JSON.parse(body) as { success?: boolean };
        if (typeof parsed.success !== "boolean") continue;
      } catch {
        continue;
      }
      return new NextResponse(body, {
        status: upstream.status,
        headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
      });
    } catch {
      /* prova fallback */
    }
  }
  return null;
}

export async function GET(req: Request) {
  if (isVercelUiHost()) {
    const proxied = await proxyToEngine(req, "/api/gare", { timeoutMs: 60_000 });
    if (proxied) return proxied;
    return NextResponse.json(
      {
        success: false,
        error:
          "Motore Hetzner non raggiungibile. Le gare sono sul server di scansione — riprova tra qualche secondo.",
      },
      { status: 503 }
    );
  }

  try {
    const url = new URL(req.url);
    const region = url.searchParams.get("region");
    const priorityOnly = url.searchParams.get("priority") === "1";

    const leads = await prisma.lead.findMany({
      where: {
        type: "TENDER",
        ...(region && ["Veneto", "Campania"].includes(region) ? { region } : {}),
        ...(priorityOnly
          ? { category: { in: ["GARE_HIGH", "GARE_MEDIUM"] } }
          : {}),
      },
      orderBy: [{ leadScore: "desc" }, { tenderAmount: "desc" }, { createdAt: "desc" }],
      take: 2000,
    });
    const fresh = leads.filter((l) => isFreshTenderLead(l.evidence));
    fresh.sort((a, b) => {
      const da = parseTenderAwardDateObj(a.evidence)?.getTime() ?? 0;
      const db = parseTenderAwardDateObj(b.evidence)?.getTime() ?? 0;
      if (db !== da) return db - da;
      return (b.leadScore ?? 0) - (a.leadScore ?? 0);
    });
    return NextResponse.json({ success: true, data: fresh, hiddenStale: leads.length - fresh.length });
  } catch {
    return NextResponse.json({ success: false, error: "Errore durante il recupero delle gare" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  if (isVercelUiHost()) {
    const proxied = await proxyToEngine(req);
    if (proxied) return proxied;
  }

  try {
    const res = await prisma.lead.deleteMany({
      where: {
        type: "TENDER",
        OR: [
          { companyName: { startsWith: "Edilizia Costruzioni" } },
          { tenderCig: { startsWith: "Z" } },
        ],
      },
    });
    return NextResponse.json({
      success: true,
      message: `Rimossi ${res.count} lead simulati.`,
      removed: res.count,
    });
  } catch {
    return NextResponse.json({ success: false, error: "Errore durante la pulizia." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  if (isVercelUiHost()) {
    const proxied = await proxyToEngine(req, "/api/gare", {
      body: rawBody,
      timeoutMs: 280_000,
    });
    if (proxied) return proxied;
    return NextResponse.json(
      {
        success: false,
        error:
          "Motore Hetzner non raggiungibile o timeout import ANAC (>4 min). Riprova; l'import può richiedere 1–2 minuti.",
      },
      { status: 503 }
    );
  }

  try {
    const body = JSON.parse(rawBody || "{}") as {
      region?: string;
      max?: number | "all";
      commercialOnly?: boolean;
      reEnrich?: boolean;
    };

    if (!body.region || !["Veneto", "Campania"].includes(body.region)) {
      return NextResponse.json({ success: false, error: "Regione non supportata." }, { status: 400 });
    }

    const { runGareScan } = await import("@/lib/gare/engine");
    const result = await runGareScan({
      region: body.region,
      max: body.max,
      commercialOnly: body.commercialOnly !== false,
      reEnrich: body.reEnrich === true,
    });

    return NextResponse.json({
      success: true,
      message: result.message,
      stats: result.stats,
      data: result.data,
    });
  } catch (error) {
    console.error("Errore nel motore Gare:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          "Errore nel motore gare ANAC. Riprova; se persiste, potrebbe essere un blocco di rete.",
      },
      { status: 500 }
    );
  }
}
