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
import { isInActionableSalesQueue, passesDefaultClientQueueGate } from "@/lib/sanita/actionable-queue";
import { presentSanitaLead } from "@/lib/sanita/present-sanita-lead";
import { readBusinessVerdict, readProcessingState } from "@/lib/sanita/processing-state";
import { isLegacyLead } from "@/lib/sanita/evidence-version";

/** KPI presentation-only — conteggi su DB grezzo, indipendenti dal filtro coda. */
function buildSanitaAuditKpis(
  leads: Array<{ evidence?: string | null; lastScannedAt?: Date | string | null }>
) {
  const k = {
    total: leads.length,
    actionable: 0,
    HOT_VERIFIED: 0,
    PUBLISHED_CURRENT: 0,
    PUBLISHED_EXPIRED: 0,
    PUBLISHED_DATE_UNKNOWN: 0,
    PUBLISHED_INCOMPLETE: 0,
    PUBLISHED_ANALOGOUS_MEASURE: 0,
    SELF_INSURANCE_VERIFIED: 0,
    RETRY_PENDING: 0,
    REVIEW_HUMAN: 0,
    TECHNICAL_BLOCKED: 0,
    OUT_OF_SCOPE: 0,
    inRevalidation: 0,
    notYetCertified: 0,
    LEGACY: 0,
    commercial: {
      policyValid: 0,
      policyExpired: 0,
      dateUnknown: 0,
      selfInsurance: 0,
      absenceCertified: 0,
    },
  };
  for (const l of leads) {
    const actionable = isInActionableSalesQueue(l);
    if (actionable) k.actionable++;
    const ps = readProcessingState(l.evidence);
    const bv = readBusinessVerdict(l.evidence);
    if (ps === "HOT_VERIFIED") k.HOT_VERIFIED++;
    else if (ps === "SELF_INSURANCE_VERIFIED" || bv === "SELF_INSURANCE_VERIFIED") {
      k.SELF_INSURANCE_VERIFIED++;
    } else if (ps === "PUBLISHED_CURRENT" || bv === "PUBLISHED_CURRENT") k.PUBLISHED_CURRENT++;
    else if (ps === "PUBLISHED_EXPIRED" || bv === "PUBLISHED_EXPIRED") k.PUBLISHED_EXPIRED++;
    else if (ps === "PUBLISHED_DATE_UNKNOWN" || bv === "PUBLISHED_DATE_UNKNOWN") k.PUBLISHED_DATE_UNKNOWN++;
    else if (ps === "PUBLISHED_INCOMPLETE" || bv === "PUBLISHED_INCOMPLETE") k.PUBLISHED_INCOMPLETE++;
    else if (ps === "PUBLISHED_ANALOGOUS_MEASURE" || bv === "PUBLISHED_ANALOGOUS_MEASURE") {
      k.PUBLISHED_ANALOGOUS_MEASURE++;
    } else if (ps === "RETRY_PENDING") k.RETRY_PENDING++;
    else if (ps === "REVIEW_HUMAN" || bv === "REVIEW_HUMAN") k.REVIEW_HUMAN++;
    else if (ps === "TECHNICAL_BLOCKED") k.TECHNICAL_BLOCKED++;
    else if (ps === "OUT_OF_SCOPE" || bv === "OUT_OF_SCOPE") k.OUT_OF_SCOPE++;

    if (isLegacyLead(l.evidence)) k.LEGACY++;
    if (
      !actionable &&
      (ps === "RETRY_PENDING" ||
        ps === "TECHNICAL_BLOCKED" ||
        ps === "REVIEW_HUMAN" ||
        isLegacyLead(l.evidence) ||
        Boolean(l.lastScannedAt))
    ) {
      k.inRevalidation++;
    }

    // Solo lead certificati/vendibili — voci commerciali (include autoassicurazione)
    if (actionable) {
      if (ps === "HOT_VERIFIED") k.commercial.absenceCertified++;
      else if (ps === "SELF_INSURANCE_VERIFIED" || bv === "SELF_INSURANCE_VERIFIED") {
        k.commercial.selfInsurance++;
      } else if (ps === "PUBLISHED_CURRENT" || bv === "PUBLISHED_CURRENT") k.commercial.policyValid++;
      else if (ps === "PUBLISHED_EXPIRED" || bv === "PUBLISHED_EXPIRED") k.commercial.policyExpired++;
      else if (ps === "PUBLISHED_DATE_UNKNOWN" || bv === "PUBLISHED_DATE_UNKNOWN") k.commercial.dateUnknown++;
      else if (
        ps === "PUBLISHED_INCOMPLETE" ||
        ps === "PUBLISHED_ANALOGOUS_MEASURE" ||
        bv === "PUBLISHED_INCOMPLETE" ||
        bv === "PUBLISHED_ANALOGOUS_MEASURE" ||
        (ps && String(ps).startsWith("PUBLISHED")) ||
        (bv && String(bv).startsWith("PUBLISHED"))
      ) {
        k.commercial.dateUnknown++;
      } else if (/\[V:PUB\]/i.test(l.evidence || "")) {
        k.commercial.dateUnknown++;
      } else {
        k.commercial.absenceCertified++;
      }
    }
  }
  k.notYetCertified = Math.max(0, k.total - k.actionable);
  return k;
}

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
    const leadId = url.searchParams.get("id");
    if (leadId?.trim()) {
      const lead = await prisma.lead.findUnique({ where: { id: leadId.trim() } });
      if (!lead || lead.type !== "HEALTHCARE") {
        return NextResponse.json(
          { success: false, error: "Lead non trovato", found: false },
          { status: 404 }
        );
      }
      const semantic = presentSanitaLead(lead);
      return NextResponse.json({
        success: true,
        found: true,
        lead,
        semantic,
        data: [lead],
        meta: {
          actionable: semantic.actionable,
          queueStatus: semantic.queueStatus,
        },
      });
    }
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
    // Default sicuro: coda commerciale = solo evidence corrente.
    // Ops/audit: ?includeAll=1 (o actionable=0 / flag env false).
    const includeAll =
      url.searchParams.get("includeAll") === "1" ||
      url.searchParams.get("actionable") === "0";
    const requireActionable =
      process.env.ACTIONABLE_QUEUE_REQUIRE_CURRENT_EVIDENCE !== "0" &&
      url.searchParams.get("actionable") !== "0";
    const actionableOnly =
      url.searchParams.get("actionable") === "1" || (requireActionable && !includeAll);
    const data = actionableOnly
      ? leads.filter((l) =>
          url.searchParams.get("actionable") === "1"
            ? isInActionableSalesQueue(l)
            : passesDefaultClientQueueGate(l)
        )
      : leads.map((l) => {
          const semantic = presentSanitaLead(l);
          return {
            ...l,
            semantic,
            _actionable: semantic.actionable,
            _legacy: !semantic.actionable && !!l.evidence,
            _queueStatus: semantic.queueStatus,
          };
        });
    const actionableCount = leads.filter((l) => isInActionableSalesQueue(l)).length;
    const kpis = buildSanitaAuditKpis(leads);
    return NextResponse.json({
      success: true,
      data,
      meta: {
        tavilyAvailable: isRegionalCheckAvailable(),
        regions: await regionScanMeta(),
        actionableQueueRequireCurrentEvidence:
          process.env.ACTIONABLE_QUEUE_REQUIRE_CURRENT_EVIDENCE !== "0",
        actionableCount,
        dbTotal: leads.length,
        totalReturned: data.length,
        filteredDefault: actionableOnly,
        includeAll: Boolean(includeAll),
        kpis,
        /** Hint UI: coda commerciale vuota ma DB popolato → rivalidazione / fail-closed. */
        revalidationUiLock: actionableCount === 0 && leads.length > 0,
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
      published: 0,
      hot: 0,
      review: 0,
      reviewHuman: 0,
      retryPending: 0,
      technicalBlocked: 0,
      outOfScope: 0,
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
