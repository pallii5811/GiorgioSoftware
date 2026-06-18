import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runGareScan } from "@/lib/gare/engine";
import {
  getScanEngineUrl,
  HETZNER_SCAN_ENGINE,
  isVercelUiHost,
} from "@/lib/sanita/scan-engine-url";

export const runtime = "nodejs";
export const maxDuration = 300;

async function proxyToEngine(req: Request, path = "/api/gare"): Promise<NextResponse | null> {
  const bases = [getScanEngineUrl(), HETZNER_SCAN_ENGINE].filter(
    (v, i, a) => v && a.indexOf(v) === i
  );
  const url = new URL(req.url);
  for (const base of bases) {
    try {
      const init: RequestInit = {
        method: req.method,
        cache: "no-store",
        headers: { "Content-Type": req.headers.get("Content-Type") ?? "application/json" },
      };
      if (req.method !== "GET" && req.method !== "HEAD") {
        init.body = await req.text();
      }
      const upstream = await fetch(`${base}${path}${url.search}`, init);
      if (!upstream.ok && upstream.status >= 500) continue;
      const body = await upstream.text();
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
    const proxied = await proxyToEngine(req);
    if (proxied) return proxied;
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
    return NextResponse.json({ success: true, data: leads });
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
  if (isVercelUiHost()) {
    const proxied = await proxyToEngine(req);
    if (proxied) return proxied;
  }

  try {
    const body = (await req.json()) as {
      region?: string;
      max?: number | "all";
      commercialOnly?: boolean;
      reEnrich?: boolean;
    };

    if (!body.region || !["Veneto", "Campania"].includes(body.region)) {
      return NextResponse.json({ success: false, error: "Regione non supportata." }, { status: 400 });
    }

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
