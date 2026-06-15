import { prisma } from "@/lib/prisma";
import type { Region } from "@/lib/sanita/discovery";
import { discoverRegionFromMaps } from "@/lib/sanita/discover-region";
import { getRegionCities } from "@/lib/sanita/region-cities";
import { closeMapsBrowserPool } from "@/lib/sanita/playwright-maps";
import { isRegionalCheckAvailable } from "@/lib/sanita/regional-check";
import { terminateOcrWorker } from "@/lib/sanita/ocr";
import { serializeLeadForClient } from "@/lib/sanita/lead-serialize";
import {
  completeLeadAnalysis,
  markNoWebsiteReview,
  type ScanCounters,
} from "@/lib/sanita/scan-engine";
import {
  SCAN_BUDGET_MS,
  SCAN_DISCOVERY_SHARE,
  SCAN_DISCOVERY_SKIP_BACKLOG,
  SCAN_INITIAL_DISCOVERY_MS,
  SCAN_LEAD_TIMEOUT_MS,
  SCAN_STREAM_CONCURRENCY,
} from "@/lib/sanita/scan-config";
import { packEvidence } from "@/lib/sanita/audit";
import { ensureSqliteWal } from "@/lib/sanita/db-ready";

export { SCAN_BUDGET_MS };

export type ScanStreamInput = {
  region: Region;
  forceDiscovery?: boolean;
  continueAnalysis?: boolean;
  /**
   * Demo cliente: azzera analisi nel DB (mantiene le schede struttura), riscopre Maps,
   * rianalizza tutto — la UI riceve un lead SSE alla volta.
   */
  liveRescan?: boolean;
  /** Elimina fisicamente i record (solo uso amministrativo). */
  freshScan?: boolean;
  fixMissingWebsites?: boolean;
  mapsCityOffset?: number;
  city?: string | null;
};

export type ScanStreamEmitter = (event: string, data: Record<string, unknown>) => void;

export async function buildScanStats(
  region: Region,
  cityFilter: { city?: string },
  counters: ScanCounters,
  extra: {
    discoveredCount: number;
    mapsDiscovered: number;
    mapsCityOffset: number;
    mapsDiscoveryComplete: boolean;
    skippedDiscovery: boolean;
  }
) {
  const remainingUnscanned = await prisma.lead.count({
    where: { type: "HEALTHCARE", region, ...cityFilter, lastScannedAt: null },
  });
  const remainingWeb = await prisma.lead.count({
    where: { type: "HEALTHCARE", region, ...cityFilter, website: { not: null }, lastScannedAt: null },
  });
  const regionalAvailable = isRegionalCheckAvailable();

  return {
    discovered: extra.discoveredCount,
    mapsDiscovered: extra.mapsDiscovered,
    mapsCityOffset: extra.mapsCityOffset,
    mapsDiscoveryComplete: extra.mapsDiscoveryComplete,
    analyzed: counters.analyzed,
    withPolicy: counters.withPolicy,
    hot: counters.hot,
    review: counters.review,
    remainingUnscanned,
    remainingWeb,
    regionalAvailable,
    regionalChecked: counters.regionalChecked,
    regionalWithPolicy: counters.regionalWithPolicy,
    skippedDiscovery: extra.skippedDiscovery,
    done: extra.discoveredCount - remainingUnscanned,
    total: extra.discoveredCount,
    complete: remainingUnscanned === 0 && extra.mapsDiscoveryComplete,
  };
}

/**
 * Scansione live Maps-first:
 * 1) Google Maps scopre strutture (nome + sito dalla scheda)
 * 2) Crawl diretto di ogni sito — analisi completa prima di mostrare il lead
 */
export async function runStreamingScan(input: ScanStreamInput, emit: ScanStreamEmitter) {
  await ensureSqliteWal();
  process.env.POLICY_EXHAUSTIVE = process.env.POLICY_EXHAUSTIVE ?? "1";
  process.env.OCR_ENABLED = process.env.OCR_ENABLED ?? "1";
  const {
    region,
    forceDiscovery = false,
    continueAnalysis = false,
    liveRescan = false,
    freshScan = false,
    fixMissingWebsites = false,
    mapsCityOffset: mapsOffsetIn = 0,
    city = null,
  } = input;
  const cityFilter = city && city.trim() ? { city: city.trim() } : {};
  const deadline = Date.now() + SCAN_BUDGET_MS;
  const regionalAvailable = isRegionalCheckAvailable();
  const regionCities = await getRegionCities(region);
  const needMoreMapsCities = mapsOffsetIn < regionCities.length;
  const runDiscovery =
    liveRescan || !continueAnalysis || forceDiscovery || needMoreMapsCities;

  if (freshScan) {
    await prisma.lead.deleteMany({
      where: { type: "HEALTHCARE", region, ...cityFilter },
    });
    emit("progress", {
      phase: "discovery",
      message: `Regione ${region} — record eliminati, nuova scoperta…`,
      done: 0,
      total: 0,
    });
  } else if (liveRescan) {
    await prisma.lead.updateMany({
      where: { type: "HEALTHCARE", region, ...cityFilter },
      data: {
        lastScannedAt: null,
        policyFound: false,
        policyCompany: null,
        policyMassimale: null,
        policyNumber: null,
        policyExpiry: null,
        confidence: null,
        evidence: null,
        websiteReachable: null,
        pagesVisited: 0,
        leadScore: 0,
      },
    });
    emit("progress", {
      phase: "discovery",
      message: `Demo live ${region} — 0 analizzati, riscansione in tempo reale…`,
      done: 0,
      total: 0,
    });
  } else if (continueAnalysis) {
    emit("progress", {
      phase: "discovery",
      message: `Continua scansione ${region}…`,
      done: 0,
      total: 0,
    });
  }

  if (fixMissingWebsites) {
    await prisma.lead.updateMany({
      where: { type: "HEALTHCARE", region, ...cityFilter, website: null },
      data: { lastScannedAt: null },
    });
  }

  let mapsCityOffset = mapsOffsetIn;
  let mapsDiscovered = 0;
  let saluteAdded = 0;
  let mapsDiscoveryComplete = !needMoreMapsCities;

  const pendingWithSite = await prisma.lead.count({
    where: { type: "HEALTHCARE", region, ...cityFilter, website: { not: null }, lastScannedAt: null },
  });
  const skipDiscoveryForBacklog =
    !liveRescan && continueAnalysis && pendingWithSite >= SCAN_DISCOVERY_SKIP_BACKLOG;

  const discoveryMs =
    liveRescan || !continueAnalysis
      ? SCAN_INITIAL_DISCOVERY_MS
      : Math.floor(SCAN_BUDGET_MS * SCAN_DISCOVERY_SHARE);
  const discoveryDeadline = Math.min(deadline, Date.now() + discoveryMs);

  if (runDiscovery && !skipDiscoveryForBacklog && Date.now() < discoveryDeadline) {
    emit("progress", {
      phase: "discovery",
      message: `Google Maps — scoperta strutture in ${region}…`,
      done: 0,
      total: 0,
    });
    try {
      const d = await discoverRegionFromMaps(region, { deadline: discoveryDeadline, cityOffset: mapsCityOffset });
      mapsCityOffset = d.mapsCityOffset;
      mapsDiscovered = d.mapsDiscovered;
      saluteAdded = d.saluteAdded;
      mapsDiscoveryComplete = d.discoveryComplete;
      emit("progress", {
        phase: "discovery",
        message: `Maps +${d.mapsDiscovered}${d.saluteAdded ? ` · Min.Salute +${d.saluteAdded}` : ""} (città ${d.mapsCityOffset}/${d.citiesTotal})`,
        done: 0,
        total: 0,
      });
    } catch (err) {
      console.error("Maps discovery:", err);
    }
  }

  const discoveredCount = await prisma.lead.count({
    where: { type: "HEALTHCARE", region, ...cityFilter },
  });
  const counters: ScanCounters = {
    analyzed: 0,
    withPolicy: 0,
    hot: 0,
    review: 0,
    regionalChecked: 0,
    regionalWithPolicy: 0,
  };

  let doneBefore = await prisma.lead.count({
    where: { type: "HEALTHCARE", region, ...cityFilter, lastScannedAt: { not: null } },
  });

  emit("progress", {
    phase: "analysis",
    message: "Crawl sito per sito (dalla scheda Maps)…",
    done: doneBefore,
    total: discoveredCount,
  });

  while (Date.now() < deadline) {
    const batch = await prisma.lead.findMany({
      where: { type: "HEALTHCARE", region, ...cityFilter, lastScannedAt: null },
      orderBy: [{ website: "desc" }, { createdAt: "asc" }],
      take: SCAN_STREAM_CONCURRENCY,
    });
    if (batch.length === 0) break;

    // Ogni lead compare appena finisce — non aspettare l'intero batch (bug 0/69 per 10+ min).
    await Promise.all(
      batch.map(async (lead) => {
        const cityLabel = lead.city ? ` · ${lead.city}` : "";
        emit("progress", {
          phase: "analysis",
          message: `Analisi: ${lead.companyName}${cityLabel}`,
          processingId: lead.id,
          processingName: lead.companyName,
          done: doneBefore,
          total: discoveredCount,
        });

        try {
          const exhaustive =
            process.env.POLICY_EXHAUSTIVE !== "0" && process.env.POLICY_EXHAUSTIVE !== "false";
          const run = () => completeLeadAnalysis(lead, region, counters);
          if (exhaustive) {
            await run();
          } else {
            await Promise.race([
              run(),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () => reject(new Error("timeout analisi struttura")),
                  SCAN_LEAD_TIMEOUT_MS
                )
              ),
            ]);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`Lead ${lead.companyName}: ${msg}`);
          await prisma.lead.update({
            where: { id: lead.id },
            data: {
              lastScannedAt: new Date(),
              evidence: packEvidence(
                "REVIEW",
                `Analisi non completata in tempo (${msg}). Usa «Continua scansione» per riprovare.`,
                { mapsLookup: true }
              ),
            },
          });
          counters.review++;
        }

        const fresh = await prisma.lead.findUnique({ where: { id: lead.id } });
        if (!fresh?.lastScannedAt) return;

        doneBefore = await prisma.lead.count({
          where: { type: "HEALTHCARE", region, ...cityFilter, lastScannedAt: { not: null } },
        });
        emit("lead", { lead: serializeLeadForClient(fresh) });
        emit("progress", {
          phase: "analysis",
          message: `Completato: ${fresh.companyName}`,
          done: doneBefore,
          total: discoveredCount,
          lastVerdict: fresh.evidence?.slice(0, 12) ?? null,
        });
      })
    );
  }

  if (!regionalAvailable) {
    await markNoWebsiteReview(region, cityFilter, deadline);
  }

  await terminateOcrWorker().catch(() => {});
  await closeMapsBrowserPool().catch(() => {});

  const stats = await buildScanStats(region, cityFilter, counters, {
    discoveredCount,
    mapsDiscovered,
    mapsCityOffset,
    mapsDiscoveryComplete,
    skippedDiscovery: !runDiscovery,
  });

  const message =
    (city ? `Comune ${city}: ` : `${region}: `) +
    `${discoveredCount} strutture (Maps + accreditate). ` +
    (saluteAdded > 0 ? `+${saluteAdded} da Min. Salute. ` : "") +
    `Analizzate ${stats.done} (${counters.hot} senza polizza, ${counters.withPolicy} con polizza). ` +
    (stats.complete
      ? "Scansione completata."
      : mapsDiscoveryComplete
        ? `Ancora ${stats.remainingUnscanned} in coda — continua automaticamente.`
        : `Scoperta Maps in corso (città ${mapsCityOffset}) — continua automaticamente.`);

  if (stats.complete) {
    emit("complete", { message, stats });
  } else {
    emit("paused", { message, stats, mapsCityOffset });
  }
}
