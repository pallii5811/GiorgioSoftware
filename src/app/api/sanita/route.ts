import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Region } from "@/lib/sanita/discovery";
import { isRegionalCheckAvailable } from "@/lib/sanita/regional-check";
import { getRegionDiscoveryState, resetRegionDiscoveryState, saveRegionDiscoveryState } from "@/lib/sanita/discovery-state";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  SCAN_ANALYSIS_CONCURRENCY,
  SCAN_BUDGET_MS,
  SCAN_DISCOVERY_SHARE,
  SCAN_DISCOVERY_SKIP_BACKLOG,
} from "@/lib/sanita/scan-config";
import {
  getScanEngineUrl,
  HETZNER_SCAN_ENGINE,
  isVercelUiHost,
} from "@/lib/sanita/scan-engine-url";
import { stopBatchPipeline } from "@/lib/sanita/scan-coordinator";

export const runtime = "nodejs";
export const maxDuration = 300;

const execFileAsync = promisify(execFile);
const RESET_LOCK_PATH = path.join(process.cwd(), ".reset.lock");
const RESET_LOCK_TTL_MS = 5 * 60_000; // auto-riparazione: lock vecchi = considerati stantii

type ResetLockFile = {
  startedAt: string;
  pid: number;
};

async function resetLockExists(): Promise<boolean> {
  try {
    const raw = await fs.promises.readFile(RESET_LOCK_PATH, "utf8").catch(() => "");
    if (!raw.trim()) return true; // lock legacy/empty: valido ma verrà rimosso da TTL al prossimo reset
    const parsed = JSON.parse(raw) as Partial<ResetLockFile>;
    const started = parsed.startedAt ? Date.parse(parsed.startedAt) : NaN;
    if (!Number.isFinite(started)) return true;
    const age = Date.now() - started;
    if (age <= RESET_LOCK_TTL_MS) return true;
    // Lock stantio (crash/reboot a metà reset): auto-sblocco per evitare deadlock.
    await fs.promises.unlink(RESET_LOCK_PATH).catch(() => {});
    return false;
  } catch {
    return false;
  }
}

async function acquireResetLock(): Promise<{ ok: true } | { ok: false; message: string }> {
  // Se esiste un lock stantio, lo rimuove prima di provare.
  await resetLockExists();
  try {
    const payload: ResetLockFile = { startedAt: new Date().toISOString(), pid: process.pid };
    await fs.promises
      .open(RESET_LOCK_PATH, "wx")
      .then(async (f) => {
        await f.writeFile(JSON.stringify(payload), { encoding: "utf8" });
        await f.close();
      });
    return { ok: true };
  } catch {
    return { ok: false, message: "Reset già in corso. Attendi la fine e riprova." };
  }
}

async function releaseResetLock(): Promise<void> {
  await fs.promises.unlink(RESET_LOCK_PATH).catch(() => {});
}

async function stopPipelineProcesses(): Promise<void> {
  await stopBatchPipeline();
}

/** Vercel UI → legge i lead dal motore Hetzner (stesso DB della scansione). */
async function proxyGetToEngine(req: Request) {
  const bases = [getScanEngineUrl(), HETZNER_SCAN_ENGINE].filter(
    (v, i, a) => v && a.indexOf(v) === i
  );
  const url = new URL(req.url);
  for (const base of bases) {
    try {
      const upstream = await fetch(`${base}/api/sanita${url.search}`, { cache: "no-store" });
      if (!upstream.ok) continue;
      const body = await upstream.text();
      return new NextResponse(body, {
        status: upstream.status,
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      /* prova fallback */
    }
  }
  return null;
}

async function regionScanMeta() {
  const regions = {} as Record<
    string,
    {
      total: number;
      done: number;
      pending: number;
      discovery: Awaited<ReturnType<typeof getRegionDiscoveryState>>;
    }
  >;
  for (const region of ["Veneto", "Campania"] as const) {
    const total = await prisma.lead.count({ where: { type: "HEALTHCARE", region } });
    const done = await prisma.lead.count({
      where: { type: "HEALTHCARE", region, lastScannedAt: { not: null } },
    });
    regions[region] = {
      total,
      done,
      pending: Math.max(0, total - done),
      discovery: await getRegionDiscoveryState(region),
    };
  }
  return regions;
}

export async function GET(req: Request) {
  // Solo UI Vercel: proxy verso Hetzner. Sul motore scan usa il DB locale.
  if (isVercelUiHost()) {
    const proxied = await proxyGetToEngine(req);
    if (proxied) return proxied;
  }

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
  const { discoverRegionFromMaps } = await import("@/lib/sanita/discover-region");
  const { getRegionCities } = await import("@/lib/sanita/region-cities");
  const { completeLeadAnalysis, markNoWebsiteReview } = await import("@/lib/sanita/scan-engine");
  const { terminateOcrWorker } = await import("@/lib/sanita/ocr");
  const { closeMapsBrowserPool } = await import("@/lib/sanita/playwright-maps");

  // Reset in corso: non avviare scansioni concorrenti (evita P2025 / stato incoerente).
  if (await resetLockExists()) {
    return NextResponse.json(
      { success: false, error: "Reset regione in corso. Riprova tra pochi secondi." },
      { status: 409 }
    );
  }

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
    const counters = {
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
    const citiesTotal = regionCities.length;
    await saveRegionDiscoveryState(region, { mapsCityOffset, mapsDiscoveryComplete });

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
        citiesTotal,
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
  const lock = await acquireResetLock();
  if (!lock.ok) {
    return NextResponse.json({ success: false, error: lock.message }, { status: 409 });
  }
  try {
    const region = new URL(req.url).searchParams.get("region");
    if (!region || !["Veneto", "Campania"].includes(region)) {
      return NextResponse.json(
        { success: false, error: "Specificare ?region=Veneto oppure ?region=Campania" },
        { status: 400 }
      );
    }
    await stopPipelineProcesses();
    resetRegionDiscoveryState(region as "Campania" | "Veneto");
    const res = await prisma.lead.deleteMany({ where: { type: "HEALTHCARE", region } });
    return NextResponse.json({
      success: true,
      removed: res.count,
      message: `Regione ${region} azzerata: ${res.count} strutture rimosse. Pronta per scansione live.`,
    });
  } catch {
    return NextResponse.json({ success: false, error: "Errore durante il reset regione" }, { status: 500 });
  } finally {
    await releaseResetLock();
  }
}
