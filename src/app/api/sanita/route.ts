import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Region } from "@/lib/sanita/discovery";
import { discoverRegionFromMaps } from "@/lib/sanita/discover-region";
import { getRegionCities } from "@/lib/sanita/region-cities";
import { closeMapsBrowserPool } from "@/lib/sanita/playwright-maps";
import { isRegionalCheckAvailable } from "@/lib/sanita/regional-check";
import { terminateOcrWorker } from "@/lib/sanita/ocr";
import {
  completeLeadAnalysis,
  markNoWebsiteReview,
  type ScanCounters,
} from "@/lib/sanita/scan-engine";
import {
  SCAN_ANALYSIS_CONCURRENCY,
  SCAN_BUDGET_MS,
  SCAN_DISCOVERY_SHARE,
  SCAN_DISCOVERY_SKIP_BACKLOG,
} from "@/lib/sanita/scan-config";

export const runtime = "nodejs";
export const maxDuration = 300;

async function regionScanMeta() {
  const regions = {} as Record<string, { total: number; done: number; pending: number }>;
  for (const region of ["Veneto", "Campania"] as const) {
    const total = await prisma.lead.count({ where: { type: "HEALTHCARE", region } });
    const done = await prisma.lead.count({
      where: { type: "HEALTHCARE", region, lastScannedAt: { not: null } },
    });
    regions[region] = { total, done, pending: Math.max(0, total - done) };
  }
  return regions;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const includePending = url.searchParams.get("includePending") === "1";
    const region = url.searchParams.get("region");
    const regionFilter =
      region && ["Veneto", "Campania"].includes(region) ? { region } : {};
    const leads = await prisma.lead.findMany({
      where: {
        type: "HEALTHCARE",
        ...regionFilter,
        ...(includePending ? {} : { lastScannedAt: { not: null } }),
      },
      orderBy: [{ leadScore: "desc" }, { lastScannedAt: "desc" }, { createdAt: "desc" }],
    });
    return NextResponse.json({
      success: true,
      data: leads,
      meta: {
        tavilyAvailable: isRegionalCheckAvailable(),
        regions: await regionScanMeta(),
      },
    });
  } catch {
    return NextResponse.json(
      { success: false, error: "Errore durante il recupero dei lead sanitari" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      region: Region;
      forceDiscovery?: boolean;
      continueAnalysis?: boolean;
      fixMissingWebsites?: boolean;
      mapsCityOffset?: number;
      city?: string | null;
    };
    const {
      region,
      forceDiscovery = false,
      continueAnalysis = false,
      fixMissingWebsites = false,
      mapsCityOffset: mapsOffsetIn = 0,
      city = null,
    } = body;
    const cityFilter = city && city.trim() ? { city: city.trim() } : {};

    if (!["Veneto", "Campania"].includes(region)) {
      return NextResponse.json({ success: false, error: "Regione non supportata." }, { status: 400 });
    }

    const regionalAvailable = isRegionalCheckAvailable();
    const deadline = Date.now() + SCAN_BUDGET_MS;
    const regionCities = await getRegionCities(region);
    const needMoreMapsCities = mapsOffsetIn < regionCities.length;
    const runDiscovery = !continueAnalysis || forceDiscovery || needMoreMapsCities;

    if (fixMissingWebsites) {
      await prisma.lead.updateMany({
        where: { type: "HEALTHCARE", region, ...cityFilter, website: null },
        data: { lastScannedAt: null },
      });
    }

    let mapsDiscovered = 0;
    let mapsCityOffset = mapsOffsetIn;
    let mapsDiscoveryComplete = !needMoreMapsCities;

    const pendingWithSite = await prisma.lead.count({
      where: { type: "HEALTHCARE", region, ...cityFilter, website: { not: null }, lastScannedAt: null },
    });
    const skipDiscoveryForBacklog =
      continueAnalysis && pendingWithSite >= SCAN_DISCOVERY_SKIP_BACKLOG;

    const discoveryDeadline = Math.min(
      deadline,
      Date.now() + Math.floor(SCAN_BUDGET_MS * SCAN_DISCOVERY_SHARE)
    );

    if (runDiscovery && !skipDiscoveryForBacklog && Date.now() < discoveryDeadline) {
      try {
        const d = await discoverRegionFromMaps(region, { deadline: discoveryDeadline, cityOffset: mapsCityOffset });
        mapsCityOffset = d.mapsCityOffset;
        mapsDiscovered = d.mapsDiscovered;
        mapsDiscoveryComplete = d.discoveryComplete;
      } catch (err) {
        console.error("Maps discovery:", err);
      }
    }

    const discoveredCount = await prisma.lead.count({ where: { type: "HEALTHCARE", region, ...cityFilter } });
    const counters: ScanCounters = {
      analyzed: 0,
      withPolicy: 0,
      hot: 0,
      review: 0,
      regionalChecked: 0,
      regionalWithPolicy: 0,
    };

    while (Date.now() < deadline) {
      const batch = await prisma.lead.findMany({
        where: { type: "HEALTHCARE", region, ...cityFilter, lastScannedAt: null },
        orderBy: [{ website: "desc" }, { createdAt: "asc" }],
        take: SCAN_ANALYSIS_CONCURRENCY,
      });
      if (batch.length === 0) break;
      await Promise.all(batch.map((lead) => completeLeadAnalysis(lead, region, counters)));
    }

    await terminateOcrWorker().catch(() => {});

    if (!regionalAvailable) {
      await markNoWebsiteReview(region, cityFilter, deadline);
    }

    const allLeads = await prisma.lead.findMany({
      where: { type: "HEALTHCARE", region, ...cityFilter },
      orderBy: [{ leadScore: "desc" }, { createdAt: "desc" }],
    });

    const remainingUnscanned = await prisma.lead.count({
      where: { type: "HEALTHCARE", region, ...cityFilter, lastScannedAt: null },
    });
    const remainingWeb = await prisma.lead.count({
      where: { type: "HEALTHCARE", region, ...cityFilter, website: { not: null }, lastScannedAt: null },
    });

    const complete = remainingUnscanned === 0 && mapsDiscoveryComplete;

    return NextResponse.json({
      success: true,
      complete,
      message:
        (city ? `Comune ${city}: ` : `${region}: `) +
        `${discoveredCount} strutture. ` +
        `Maps: +${mapsDiscovered} strutture. ` +
        `Analizzate ${counters.analyzed} (${counters.hot} senza polizza, ${counters.withPolicy} con polizza). ` +
        (regionalAvailable
          ? `Tavily: ${counters.regionalChecked} verifiche regionali. `
          : `Tavily non attivo â€” verifica TAVILY_API_KEY in .env e riavvia il server. `) +
        (complete
          ? "Scansione completata al 100%."
          : `Ancora ${remainingUnscanned} strutture in coda (il sistema continua automaticamente).`),
      data: allLeads,
      stats: {
        discovered: discoveredCount,
        mapsDiscovered,
        mapsCityOffset,
        mapsDiscoveryComplete,
        analyzed: counters.analyzed,
        withPolicy: counters.withPolicy,
        hot: counters.hot,
        review: counters.review,
        remainingUnscanned,
        remainingWeb,
        regionalAvailable,
        regionalChecked: counters.regionalChecked,
        regionalWithPolicy: counters.regionalWithPolicy,
        skippedDiscovery: !runDiscovery,
      },
    });
  } catch (error) {
    console.error("Errore fatale SanitÃ :", error);
    return NextResponse.json({ success: false, error: "Errore interno del server" }, { status: 500 });
  } finally {
    await closeMapsBrowserPool().catch(() => {});
  }
}

/** Azzera i lead sanitari di una regione (demo cliente: riparte da zero). */
export async function DELETE(req: Request) {
  try {
    const region = new URL(req.url).searchParams.get("region");
    if (!region || !["Veneto", "Campania"].includes(region)) {
      return NextResponse.json(
        { success: false, error: "Specificare ?region=Veneto oppure ?region=Campania" },
        { status: 400 }
      );
    }
    const res = await prisma.lead.deleteMany({ where: { type: "HEALTHCARE", region } });
    return NextResponse.json({
      success: true,
      removed: res.count,
      message: `Regione ${region} azzerata: ${res.count} strutture rimosse. Pronta per scansione live.`,
    });
  } catch {
    return NextResponse.json({ success: false, error: "Errore durante il reset regione" }, { status: 500 });
  }
}
