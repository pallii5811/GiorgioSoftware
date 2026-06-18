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
  SCAN_DISCOVERY_MAX_MS,
  SCAN_INITIAL_DISCOVERY_MS,
  SCAN_STREAM_CONCURRENCY,
  scanRoundDeadline,
  SCAN_LEAD_MAX_MS,
} from "@/lib/sanita/scan-config";
import { packEvidence } from "@/lib/sanita/audit";
import { isScanEngineHost } from "@/lib/sanita/scan-engine-url";
import { ensureSqliteWal } from "@/lib/sanita/db-ready";
import { dedupeRegionByWebsite } from "@/lib/sanita/lead-dedup";
import { acquireLiveScanLock, releaseLiveScanLock, stopBatchPipeline } from "@/lib/sanita/scan-coordinator";

export { SCAN_BUDGET_MS };

/** Errore infrastruttura (lock, browser, rete) — non è un verdetto Gelli. */
function isTransientAnalysisFailure(msg: string): boolean {
  return (
    /Timeout lock analisi/i.test(msg) ||
    /Analisi oltre \d+ min/i.test(msg) ||
    /Target (page|context|browser).*closed/i.test(msg) ||
    /Browser has been closed/i.test(msg) ||
    /Execution context was destroyed/i.test(msg) ||
    /ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(msg)
  );
}

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
    citiesTotal: number;
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
    citiesTotal: extra.citiesTotal,
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

  let liveScanLocked = false;
  if (isScanEngineHost()) {
    await acquireLiveScanLock(region);
    liveScanLocked = true;
  }

  try {
  const deduped = await dedupeRegionByWebsite(region);
  if (deduped > 0) {
    emit("progress", {
      phase: "analysis",
      message: `${region} — unificati ${deduped} duplicati (stesso sito web)`,
      done: 0,
      total: 0,
    });
  }

  const deadline = scanRoundDeadline();
  const regionalAvailable = isRegionalCheckAvailable();
  const regionCities = await getRegionCities(region);
  const citiesTotal = regionCities.length;
  const { getRegionDiscoveryState, saveRegionDiscoveryState } = await import(
    "@/lib/sanita/discovery-state"
  );
  const serverDiscovery = await getRegionDiscoveryState(region);
  // Continua: usa il massimo tra offset client e server (non perdere progresso Hetzner).
  const effectiveMapsOffset =
    continueAnalysis && !freshScan
      ? Math.max(mapsOffsetIn, serverDiscovery.mapsCityOffset)
      : freshScan
        ? 0
        : mapsOffsetIn;
  let mapsCityOffset = effectiveMapsOffset;
  const needMoreMapsCities = mapsCityOffset < citiesTotal;
  const existingCount = await prisma.lead.count({
    where: { type: "HEALTHCARE", region, ...cityFilter },
  });
  const doneBeforeStart = await prisma.lead.count({
    where: { type: "HEALTHCARE", region, ...cityFilter, lastScannedAt: { not: null } },
  });
  // Continua Campania: deve ancora scoprire comuni Maps se l'offset non è completo.
  const runDiscovery =
    needMoreMapsCities &&
    (freshScan || forceDiscovery || continueAnalysis || existingCount === 0);

  if (freshScan) {
    await saveRegionDiscoveryState(region, { mapsCityOffset: 0, mapsDiscoveryComplete: false });
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
      phase: "analysis",
      message: `Riscansione ${region} — ${existingCount} strutture in coda…`,
      done: 0,
      total: existingCount,
    });
  } else if (continueAnalysis) {
    emit("progress", {
      phase: "analysis",
      message: `Continua scansione ${region} (${doneBeforeStart}/${existingCount})…`,
      done: doneBeforeStart,
      total: existingCount,
    });
  } else if (existingCount > 0) {
    emit("progress", {
      phase: "analysis",
      message: `${region} — avvio analisi su ${existingCount} strutture…`,
      done: doneBeforeStart,
      total: existingCount,
    });
  }

  if (fixMissingWebsites) {
    await prisma.lead.updateMany({
      where: { type: "HEALTHCARE", region, ...cityFilter, website: null },
      data: { lastScannedAt: null },
    });
  }

  let mapsDiscovered = 0;
  let saluteAdded = 0;
  let mapsDiscoveryComplete = !needMoreMapsCities;

  const pendingWithSite = await prisma.lead.count({
    where: { type: "HEALTHCARE", region, ...cityFilter, website: { not: null }, lastScannedAt: null },
  });
  const skipDiscoveryForBacklog =
    !liveRescan && continueAnalysis && pendingWithSite >= SCAN_DISCOVERY_SKIP_BACKLOG;

  const discoveryMs = Math.min(
    liveRescan || !continueAnalysis
      ? SCAN_INITIAL_DISCOVERY_MS
      : Math.floor(SCAN_BUDGET_MS * SCAN_DISCOVERY_SHARE),
    SCAN_DISCOVERY_MAX_MS
  );
  const discoveryDeadline = Math.min(deadline, Date.now() + discoveryMs);

  if (runDiscovery && !skipDiscoveryForBacklog && Date.now() < discoveryDeadline) {
    emit("progress", {
      phase: "discovery",
      message: `Google Maps — scoperta strutture in ${region}…`,
      done: doneBeforeStart,
      total: Math.max(existingCount, doneBeforeStart),
    });
    try {
      const d = await discoverRegionFromMaps(region, { deadline: discoveryDeadline, cityOffset: mapsCityOffset });
      mapsCityOffset = d.mapsCityOffset;
      mapsDiscovered = d.mapsDiscovered;
      saluteAdded = d.saluteAdded;
      mapsDiscoveryComplete = d.discoveryComplete;
      const afterDiscovery = await prisma.lead.count({
        where: { type: "HEALTHCARE", region, ...cityFilter },
      });
      emit("progress", {
        phase: "discovery",
        message: `Maps +${d.mapsDiscovered}${d.saluteAdded ? ` · Min.Salute +${d.saluteAdded}` : ""} (comuni ${d.mapsCityOffset}/${d.citiesTotal})`,
        done: doneBeforeStart,
        total: afterDiscovery,
        mapsCityOffset: d.mapsCityOffset,
        citiesTotal: d.citiesTotal,
        mapsDiscoveryComplete: d.discoveryComplete,
      });
    } catch (err) {
      console.error("Maps discovery:", err);
      emit("progress", {
        phase: "analysis",
        message: `Maps: errore scoperta — passo all'analisi strutture già in DB`,
        done: 0,
        total: 0,
      });
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
    if (liveScanLocked) await stopBatchPipeline();
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
          const analysis = completeLeadAnalysis(lead, region, counters);
          if (SCAN_LEAD_MAX_MS > 0) {
            await Promise.race([
              analysis,
              new Promise<never>((_, reject) =>
                setTimeout(
                  () => reject(new Error(`Analisi oltre ${Math.round(SCAN_LEAD_MAX_MS / 60_000)} min`)),
                  SCAN_LEAD_MAX_MS
                )
              ),
            ]);
          } else {
            await analysis;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`Lead ${lead.companyName}: ${msg}`);
          // Timeout per-lead: non deve bloccare l'intera regione.
          // Motore (Hetzner): segna REVIEW e passa al prossimo lead.
          // UI/demo: preferiamo riprovare al round successivo per evitare falsi "completato".
          const isLeadTimeout = /Analisi oltre \d+ min/.test(msg);
          if (isLeadTimeout && !isScanEngineHost()) return;
          try {
            await prisma.lead.update({
              where: { id: lead.id },
              data: {
                lastScannedAt: new Date(),
                evidence: packEvidence(
                  "REVIEW",
                  isLeadTimeout
                    ? `Timeout analisi (${msg}). Lead messo in REVIEW per non bloccare la scansione; riprova manualmente.`
                    : `Analisi interrotta (${msg}). Usa «Rianalizza» sulla riga per riprovare.`,
                  { mapsLookup: true }
                ),
              },
            });
            counters.review++;
          } catch {
            /* lead assorbito/eliminato da dedup — ignora */
          }
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

  await saveRegionDiscoveryState(region, { mapsCityOffset, mapsDiscoveryComplete });

  const stats = await buildScanStats(region, cityFilter, counters, {
    discoveredCount,
    mapsDiscovered,
    mapsCityOffset,
    citiesTotal,
    mapsDiscoveryComplete,
    skippedDiscovery: !runDiscovery,
  });

  const message =
    (city ? `Comune ${city}: ` : `${region}: `) +
    `${discoveredCount} strutture (Maps + accreditate). ` +
    (saluteAdded > 0 ? `+${saluteAdded} da Min. Salute. ` : "") +
    `Analizzate ${stats.done} (${counters.hot} senza polizza, ${counters.withPolicy} con polizza). ` +
    (stats.complete
      ? `Scansione completata (${citiesTotal}/${citiesTotal} comuni Maps + tutte le strutture analizzate).`
      : !mapsDiscoveryComplete
        ? `Comuni Maps ${mapsCityOffset}/${citiesTotal} — clicca «Continua ${region}» per scoprire altre strutture.`
        : `Ancora ${stats.remainingUnscanned} strutture in coda — continua automaticamente.`);

  if (stats.complete) {
    emit("complete", { message, stats });
  } else {
    emit("paused", { message, stats, mapsCityOffset });
  }
  } finally {
    if (liveScanLocked) {
      await releaseLiveScanLock();
    }
  }
}
