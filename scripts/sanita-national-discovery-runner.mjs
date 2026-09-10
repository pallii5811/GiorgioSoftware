import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { prisma } from "@/lib/prisma";
import {
  readNationalDiscoveryJob,
  writeNationalDiscoveryJob,
} from "@/lib/sanita/national-discovery-jobs";
import { getRegionCities } from "@/lib/sanita/region-cities";
import { discoverRegionFromMaps } from "@/lib/sanita/discover-region";
import { closeMapsBrowserPool } from "@/lib/sanita/playwright-maps";
import { terminateOcrWorker } from "@/lib/sanita/ocr";
import {
  readProcessingState,
  stampProcessingMeta,
} from "@/lib/sanita/processing-state";

// k3 circuit-breaker resilience (2026-07-29): transient host blips must not
// park a lead for 6h. Reprobe blocked hosts after 60s and tolerate 5 consecutive
// network failures before opening the circuit. Env can still override.
process.env.CRAWL_HOST_CIRCUIT_REPROBE_MS ||= "60000";
process.env.CRAWL_HOST_CIRCUIT_THRESHOLD ||= "5";

const jobId = process.argv[2];
if (!jobId) process.exit(2);
process.env.NATIONAL_DISCOVERY_JOB_ID ||= jobId;

const frontierDir =
  process.env.NATIONAL_DISCOVERY_FRONTIER_DIR ||
  join("/var", "lib", "leadsniper", "frontiers");
mkdirSync(frontierDir, { recursive: true });
const territoryFrontierPath = join(frontierDir, `${jobId}.sqlite`);
process.env.FRONTIER_DB_PATH = territoryFrontierPath;
process.env.SHADOW_RUN_ID = `territory-${jobId}`;
// Il territorio deve usare gli stessi gate di completezza dell'archivio.
// Una slice breve è solo un checkpoint: il parent riaccoda la stessa frontiera.
process.env.POLICY_EXHAUSTIVE = "1";
process.env.OCR_ENABLED = "1";
process.env.SCAN_FAST = "0";
process.env.CRAWL_REQUIRE_EXHAUSTIVE_SITE = "1";
process.env.CRAWL_RENDER_EVERY_HTML = "1";
process.env.CRAWL_HTML_URL_CAP = "0";
process.env.SCAN_STREAM_CONCURRENCY =
  process.env.TERRITORY_SCAN_CONCURRENCY || process.env.SCAN_STREAM_CONCURRENCY || "2";
process.env.SCAN_LEAD_STALL_MS =
  process.env.TERRITORY_LEAD_STALL_MS || process.env.SCAN_LEAD_STALL_MS || "1200000";
process.env.SITEMAP_URL_CAP = process.env.SITEMAP_URL_CAP || "50000";
process.env.SITEMAP_CHILD_CAP = process.env.SITEMAP_CHILD_CAP || "2000";
process.env.CRAWL_MAX_SLICES_PER_LEAD = "1";
process.env.CRAWL_SLICE_BUDGET_MS =
  process.env.TERRITORY_SLICE_BUDGET_MS || process.env.CRAWL_SLICE_BUDGET_MS || "90000";
process.env.CRAWL_MAX_HTML_PER_SLICE =
  process.env.TERRITORY_MAX_HTML_PER_SLICE || process.env.CRAWL_MAX_HTML_PER_SLICE || "24";
process.env.PLAYWRIGHT_POLICY_MAX_URLS =
  process.env.TERRITORY_PLAYWRIGHT_MAX_URLS || process.env.PLAYWRIGHT_POLICY_MAX_URLS || "24";
process.env.PLAYWRIGHT_POLICY_MAX_MS =
  process.env.TERRITORY_PLAYWRIGHT_MAX_MS || process.env.PLAYWRIGHT_POLICY_MAX_MS || "90000";

function repairInterruptedTerritoryFrontier() {
  if (!existsSync(territoryFrontierPath)) return;
  const db = new DatabaseSync(territoryFrontierPath);
  try {
    const hasSchema = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='CrawlRun'")
      .get();
    if (!hasSchema) return;
    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      `UPDATE CrawlRun
          SET state = CASE WHEN state = 'RUNNING' THEN 'PAUSED' ELSE state END,
              workerLock = NULL,
              urlCapReached = 0,
              timeCapReached = 0`
    ).run();
    const repaired = db
      .prepare(
        `UPDATE CrawlFrontierNode
            SET state = 'RETRY_PENDING',
                nextRetryAt = ?,
                lastError = 'INTERRUPTED_FETCH_RESUME',
                updatedAt = ?
          WHERE state = 'FETCHING'`
      )
      .run(now, now);
    db.exec("COMMIT");
    console.log(
      JSON.stringify({
        event: "territory_frontier_repaired",
        interruptedFetches: Number(repaired.changes || 0),
      })
    );
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* */
    }
    throw error;
  } finally {
    db.close();
  }
}

repairInterruptedTerritoryFrontier();

const CERTIFIED_STATES = new Set([
  "HOT_VERIFIED",
  "SELF_INSURANCE_VERIFIED",
  "PUBLISHED_CURRENT",
  "PUBLISHED_EXPIRED",
  "PUBLISHED_DATE_UNKNOWN",
  "PUBLISHED_INCOMPLETE",
  "PUBLISHED_ANALOGOUS_MEASURE",
  "OUT_OF_SCOPE",
]);

function isCertifiedState(state) {
  return Boolean(state && CERTIFIED_STATES.has(state));
}

function retryPriority(lead) {
  const evidence = String(lead.evidence || "").toLocaleLowerCase("it");
  if (
    /policy_found|polizza rc pubblicata|fonte polizza pdf|published gate/.test(evidence)
  ) {
    return 0;
  }
  if (/identity:mismatch|probabile sito errato|dominio parcheggiato/.test(evidence)) {
    return 3;
  }
  if (
    lead.website &&
    /crawl incompleto|pdf non processat|timeout analisi|ocr|technical/.test(evidence)
  ) {
    return 1;
  }
  if (lead.website) return 2;
  return 4;
}

function estimatedFrontierSize(lead) {
  const match = /\[FRONTIER:[^\]]*\bn=(\d+)/i.exec(
    String(lead.evidence || "")
  );
  const size = Number(match?.[1]);
  return Number.isFinite(size) && size >= 0 ? size : Number.MAX_SAFE_INTEGER;
}

function isAutomaticallyRetryable(lead) {
  const state = readProcessingState(lead.evidence);
  const evidence = String(lead.evidence || "");
  if (
    lead.website &&
    /frontier store refuses live production paths/i.test(evidence)
  ) {
    return true;
  }
  if (
    state === "RETRY_PENDING" ||
    state === "CRAWL_RUNNING" ||
    state === "TECHNICAL_BLOCKED"
  ) {
    return Boolean(lead.website);
  }
  if (state === "REVIEW_HUMAN") {
    if (!lead.website) {
      return /sito ufficiale non individuato automaticamente/i.test(evidence);
    }
    return (
      /\[CRAWL_COMPLETE:false\]/i.test(evidence) &&
      (/\[FRONTIER:OPEN,p=[1-9]\d*/i.test(evidence) ||
        /database or disk is full|errore crawl|identity:mismatch/i.test(evidence))
    );
  }
  return Boolean(
    lead.website &&
      /crawl incompleto|pdf non processat|timeout analisi|ocr|technical|interrupted|database or disk is full/i.test(
        evidence
      )
  );
}

function automaticRetryLimit(lead, configuredMaximum) {
  if (!lead.website) return Math.min(configuredMaximum, 3);
  const evidence = String(lead.evidence || "");
  if (/identity:mismatch|dominio parcheggiato|sito errato/i.test(evidence)) {
    return Math.min(configuredMaximum, 3);
  }
  return configuredMaximum;
}

function requiresFreshWebsiteResolution(lead) {
  if (!lead.website) return true;
  return /identity:mismatch|dominio parcheggiato|sito errato/i.test(
    String(lead.evidence || "")
  );
}

function isGenuinelyUnattempted(lead) {
  if (lead.lastScannedAt) return false;
  const evidence = String(lead.evidence || "").trim();
  if (!evidence) return true;
  const state = readProcessingState(evidence);
  return (
    !state ||
    state === "DISCOVERED" ||
    state === "SCOPE_RESOLUTION" ||
    state === "SITE_RESOLUTION"
  );
}

function resumableEvidence(evidence) {
  return stampProcessingMeta(evidence || "Continuazione automatica della scansione territoriale.", {
    state: "CRAWL_RUNNING",
    businessVerdict: "NONE",
    validationStatus: "REVALIDATION_PENDING",
  });
}

let archiveWasActive = false;
let lastAutomaticStallRecoveryAt = 0;
let activeProcessingLeadId = null;
const runnerStartedAtMs = Date.now();

function readFrontierProgress() {
  if (!existsSync(territoryFrontierPath)) return null;
  const db = new DatabaseSync(territoryFrontierPath, { readOnly: true });
  try {
    const select = `
        SELECT r.leadId, r.state, r.currentCheckpoint, r.heartbeatAt,
                r.totalDiscovered, r.totalCompleted, r.totalPending,
                r.totalRetryPending, r.totalFailed,
                (
                  SELECT MAX(n.updatedAt)
                    FROM CrawlFrontierNode n
                   WHERE n.crawlRunId = r.id
                     AND n.state <> 'QUEUED'
                ) AS lastNodeProgressAt
           FROM CrawlRun r
          WHERE r.heartbeatAt >= ?`;
    const order = `
          ORDER BY CASE WHEN r.state = 'RUNNING' THEN 0 WHEN r.state = 'PAUSED' THEN 1 ELSE 2 END,
                   r.heartbeatAt DESC
          LIMIT 1`;
    // La callback dello stream non garantisce processingId su ogni cambio lead.
    // Il DB della frontiera e la fonte autorevole: scegli sempre il run RUNNING
    // con heartbeat piu recente, altrimenti un lead precedente rimasto RUNNING
    // fa apparire ferma la UI e puo attivare un recupero browser non necessario.
    // Il file frontier sopravvive ai riavvii intenzionalmente. Non mostrare però
    // run storici rimasti RUNNING/PAUSED: un dominio poi corretto (es. nike.com)
    // potrebbe altrimenti contaminare per ore la telemetria del nuovo processo.
    const currentRunnerCutoff = new Date(runnerStartedAtMs).toISOString();
    const row = db.prepare(`${select} ${order}`).get(currentRunnerCutoff);
    if (!row) {
      return {
        frontierLeadId: activeProcessingLeadId || "",
        frontierState: "STARTING",
        frontierCheckpoint: "Preparazione scansione sito",
        frontierCompleted: 0,
        frontierTotal: 0,
        frontierPending: 0,
        frontierFailed: 0,
        frontierLastProgressAt: new Date().toISOString(),
        frontierStalled: false,
      };
    }
    if (row.leadId) activeProcessingLeadId = String(row.leadId);
    const heartbeatAt = String(row.heartbeatAt || "");
    // CrawlRun heartbeatAt cambia sui checkpoint reali (fetch, OCR, Playwright);
    // durante OCR/Playwright i nodi possono restare invariati.
    const progressTimes = [row.lastNodeProgressAt, heartbeatAt]
      .map((value) => (value ? Date.parse(String(value)) : 0))
      .filter((value) => Number.isFinite(value) && value > 0);
    const lastProgressAt =
      progressTimes.length > 0
        ? new Date(Math.max(...progressTimes)).toISOString()
        : "";
    const stalledForMs = lastProgressAt
      ? Math.max(0, Date.now() - Date.parse(lastProgressAt))
      : 0;
    const progressBelongsToCurrentRunner = progressTimes.some(
      (value) => value >= runnerStartedAtMs
    );
    return {
      frontierLeadId: String(row.leadId || ""),
      frontierState: String(row.state || ""),
      frontierCheckpoint: String(row.currentCheckpoint || ""),
      frontierCompleted: Number(row.totalCompleted || 0),
      frontierTotal: Number(row.totalDiscovered || 0),
      frontierPending:
        Number(row.totalPending || 0) + Number(row.totalRetryPending || 0),
      frontierFailed: Number(row.totalFailed || 0),
      frontierLastProgressAt: lastProgressAt || null,
      // PAUSED è un checkpoint volontario tra slice, non un blocco. Solo un
      // run realmente RUNNING senza heartbeat deve attivare il watchdog;
      // altrimenti il recupero chiude OCR/browser mentre il runner sta già
      // lavorando sul comune successivo.
      frontierStalled:
        String(row.state || "") === "RUNNING" &&
        progressBelongsToCurrentRunner &&
        stalledForMs >= 8 * 60_000,
    };
  } finally {
    db.close();
  }
}

const heartbeatTimer = setInterval(() => {
  const current = readJob();
  if (
    current &&
    current.pid === process.pid &&
    (current.status === "running" || current.status === "waiting_for_archive")
  ) {
    const frontier = readFrontierProgress();
    update(frontier ? { progress: frontier } : {});
    if (
      frontier?.frontierStalled &&
      Date.now() - lastAutomaticStallRecoveryAt >= 5 * 60_000
    ) {
      lastAutomaticStallRecoveryAt = Date.now();
      void closeMapsBrowserPool().catch(() => {});
      void terminateOcrWorker().catch(() => {});
      update({
        progress: {
          ...frontier,
          message:
            "Nessun avanzamento interno da 8 minuti: recupero automatico del sito in corso.",
        },
      });
    }
  }
}, 15_000);
heartbeatTimer.unref();

function readJob() {
  return readNationalDiscoveryJob(jobId);
}

function update(patch) {
  const current = readJob();
  if (!current) return null;
  return writeNationalDiscoveryJob({
    ...current,
    ...patch,
    progress: { ...current.progress, ...(patch.progress || {}) },
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DISCOVERY_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.TERRITORY_DISCOVERY_MAX_ATTEMPTS || 3)
);
const DISCOVERY_RETRY_DELAY_MS = Math.max(
  0,
  Number(process.env.TERRITORY_DISCOVERY_RETRY_DELAY_MS || 2_000)
);

function archiveEngineActive() {
  if (process.platform === "win32") return false;
  try {
    execFileSync("systemctl", ["is-active", "--quiet", "giorgio-revalidate"], {
      timeout: 3_000,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function setArchiveEngineActive(active) {
  if (process.platform === "win32") return;
  execFileSync("systemctl", [active ? "start" : "stop", "giorgio-revalidate"], {
    timeout: 30_000,
    stdio: "ignore",
  });
}

async function reserveProtectedCapacity() {
  archiveWasActive = archiveEngineActive();
  if (!archiveWasActive) return;

  update({
    status: "waiting_for_archive",
    pid: process.pid,
    progress: {
      message: "Pausa sicura della scansione archivio in corso.",
      currentMunicipality: null,
    },
  });
  setArchiveEngineActive(false);
  const deadline = Date.now() + 60_000;
  while (archiveEngineActive() && Date.now() < deadline) await delay(1_000);
  if (archiveEngineActive()) {
    throw new Error("La scansione archivio non si e fermata entro il tempo di sicurezza");
  }
}

function resumeArchiveEngine() {
  if (!archiveWasActive) return;
  setArchiveEngineActive(true);
  archiveWasActive = false;
}

async function finishCancelled() {
  update({
    status: "cancelled",
    pid: null,
    finishedAt: new Date().toISOString(),
    progress: {
      message: "Scansione territorio annullata.",
      currentMunicipality: null,
    },
  });
}

async function run() {
  const initial = readJob();
  if (!initial) throw new Error("Job territorio non trovato");

  update({
    pid: process.pid,
    status: "queued",
    startedAt: initial.startedAt || new Date().toISOString(),
    finishedAt: null,
    errorMessage: null,
  });

  await reserveProtectedCapacity();

  const job = readJob();
  if (!job || job.cancelRequested) {
    await finishCancelled();
    return;
  }

  const allCities = await getRegionCities(job.region);
  const selectedCities = job.municipality ? [job.municipality] : allCities;
  const startAt = Math.max(
    0,
    Math.min(job.progress.municipalitiesCompleted, selectedCities.length)
  );
  const beforeTotal = await prisma.lead.count({
    where: { type: "HEALTHCARE", region: job.region },
  });
  let candidatesFound = job.progress.candidatesFound || 0;
  // Carica il motore solo dopo aver impostato FRONTIER_DB_PATH.
  const { runStreamingScan } = await import("@/lib/sanita/scan-stream");

  update({
    status: "running",
    pid: process.pid,
    progress: {
      municipalitiesTotal: selectedCities.length,
      message: "Ricerca delle strutture nel territorio.",
    },
  });

  for (let index = startAt; index < selectedCities.length; index++) {
    const current = readJob();
    if (!current || current.cancelRequested) {
      await finishCancelled();
      return;
    }

    const city = selectedCities[index];
    update({
      status: "running",
      progress: {
        currentMunicipality: city,
        message: `Ricerca strutture a ${city}.`,
      },
    });

    let result = await discoverRegionFromMaps(job.region, {
      deadline: Date.now() + Number(process.env.NATIONAL_DISCOVERY_CITY_MS || 140_000),
      cityOffset: index,
      maxCities: 1,
      cities: selectedCities,
      includeMinSalute: index === 0,
      minSaluteMunicipality: job.municipality,
    });
    let cityCandidatesFound = result.mapsDiscovered + result.saluteAdded;

    // Google Maps puo restituire occasionalmente una pagina vuota anche per un
    // comune importante. Un singolo giro vuoto non deve annullare l'intero job:
    // ricrea la sessione browser e riprova prima di dichiarare la discovery non
    // affidabile. Min. Salute viene importato solo al primo giro (upsert idempotente,
    // ma non deve gonfiare il contatore dei candidati).
    for (
      let attempt = 2;
      result.mapsCityOffset <= index && attempt <= DISCOVERY_MAX_ATTEMPTS;
      attempt++
    ) {
      update({
        status: "running",
        progress: {
          currentMunicipality: city,
          message: `Fonte di ricerca temporaneamente vuota a ${city}: nuovo tentativo ${attempt}/${DISCOVERY_MAX_ATTEMPTS}.`,
        },
      });
      await closeMapsBrowserPool().catch(() => {});
      await delay(DISCOVERY_RETRY_DELAY_MS * (attempt - 1));
      const retryResult = await discoverRegionFromMaps(job.region, {
        deadline: Date.now() + Number(process.env.NATIONAL_DISCOVERY_CITY_MS || 140_000),
        cityOffset: index,
        maxCities: 1,
        cities: selectedCities,
        includeMinSalute: false,
        minSaluteMunicipality: job.municipality,
      });
      cityCandidatesFound = Math.max(
        cityCandidatesFound,
        retryResult.mapsDiscovered + retryResult.saluteAdded
      );
      result = retryResult;
    }
    candidatesFound += cityCandidatesFound;

    if (result.mapsCityOffset <= index) {
      const existingTerritoryTotal = await prisma.lead.count({
        where: {
          type: "HEALTHCARE",
          region: job.region,
          city,
        },
      });
      if (existingTerritoryTotal > 0) {
        update({
          status: "running",
          progress: {
            municipalitiesCompleted: index + 1,
            candidatesFound,
            structuresFound: existingTerritoryTotal,
            currentMunicipality: city,
            message:
              `Fonte discovery momentaneamente indisponibile: certificazione delle ` +
              `${existingTerritoryTotal} strutture gia acquisite a ${city}.`,
          },
        });
      } else {
        update({
          status: "incomplete",
          pid: null,
          finishedAt: new Date().toISOString(),
          errorMessage: `Ricerca non completata per ${city}: nessun avanzamento affidabile.`,
          progress: {
            candidatesFound,
            currentMunicipality: city,
            message: "Ricerca sospesa in sicurezza: nessuna classificazione incerta e stata prodotta.",
          },
        });
        return;
      }
    }

    const currentTotal = await prisma.lead.count({
      where: { type: "HEALTHCARE", region: job.region },
    });
    const currentTerritoryTotal = await prisma.lead.count({
      where: {
        type: "HEALTHCARE",
        region: job.region,
        ...(job.municipality ? { city: job.municipality } : {}),
      },
    });
    update({
      progress: {
        municipalitiesCompleted: index + 1,
        candidatesFound,
        newStructuresAdded: Math.max(0, currentTotal - beforeTotal),
        structuresFound: currentTerritoryTotal,
        currentMunicipality: city,
        message: `${index + 1} di ${selectedCities.length} comuni acquisiti.`,
      },
    });

    // Risultati progressivi: una regione completa non deve attendere la discovery
    // di tutti i comuni prima di iniziare a certificare le strutture già trovate.
    await runStreamingScan(
      {
        region: job.region,
        city,
        continueAnalysis: false,
        skipDiscovery: true,
        skipDedupe: true,
      },
      (event, data) => {
        if (typeof data.processingId === "string") {
          activeProcessingLeadId = data.processingId;
        }
        if (event !== "progress" && event !== "lead") return;
        const activeFrontier =
          typeof data.processingId === "string"
            ? {
                frontierLeadId: data.processingId,
                frontierState: "STARTING",
                frontierCheckpoint: "Preparazione scansione sito",
                frontierCompleted: 0,
                frontierTotal: 0,
                frontierPending: 0,
                frontierFailed: 0,
                frontierLastProgressAt: new Date().toISOString(),
                frontierStalled: false,
              }
            : {};
        update({
          status: "running",
          progress: {
            ...activeFrontier,
            currentMunicipality: city,
            message:
              typeof data.processingName === "string"
                ? `Scansione: ${data.processingName}`
                : `Certificazione strutture di ${city}.`,
          },
        });
      }
    );

    // Una regione completa alterna discovery e certificazione comune per
    // comune. Mantieni i contatori UI allineati ai risultati già persistiti:
    // attendere la fine di tutti i comuni farebbe apparire falsamente zero.
    const progressiveLeads = await prisma.lead.findMany({
      where: {
        type: "HEALTHCARE",
        region: job.region,
        ...(job.municipality ? { city: job.municipality } : {}),
      },
      select: { evidence: true, lastScannedAt: true },
    });
    update({
      progress: {
        structuresScanned: progressiveLeads.filter((lead) => lead.lastScannedAt).length,
        certifiedResults: progressiveLeads.filter((lead) => {
          const state = readProcessingState(lead.evidence);
          return isCertifiedState(state) && state !== "OUT_OF_SCOPE";
        }).length,
      },
    });
  }

  const afterTotal = await prisma.lead.count({
    where: { type: "HEALTHCARE", region: job.region },
  });
  const scanWhere = {
    type: "HEALTHCARE",
    region: job.region,
    ...(job.municipality ? { city: job.municipality } : {}),
  };
  const structuresFound = await prisma.lead.count({ where: scanWhere });
  const attemptedIds = new Set(
    (
      await prisma.lead.findMany({
        where: { ...scanWhere, lastScannedAt: { not: null } },
        select: { id: true },
      })
    ).map((lead) => lead.id)
  );
  let structuresScanned = attemptedIds.size;
  let certifiedResults = 0;
  let continuationRound = 0;
  const retryAttempts = new Map();

  update({
    status: "running",
    progress: {
      structuresFound,
      structuresScanned,
      certifiedResults,
      currentMunicipality: job.municipality,
      message: "Scansione certificata dei siti in corso.",
    },
  });

  while (true) {
    let forceFreshResolution = false;
    const current = readJob();
    if (!current || current.cancelRequested) {
      await finishCancelled();
      return;
    }

    const territoryLeads = await prisma.lead.findMany({
      where: scanWhere,
      select: { id: true, website: true, evidence: true, lastScannedAt: true },
    });
    const certified = territoryLeads.filter((lead) =>
      isCertifiedState(readProcessingState(lead.evidence))
    );
    certifiedResults = certified.filter(
      (lead) => readProcessingState(lead.evidence) !== "OUT_OF_SCOPE"
    ).length;
    const unresolved = territoryLeads.filter(
      (lead) => !isCertifiedState(readProcessingState(lead.evidence))
    );

    if (unresolved.length === 0) break;

    const neverAttempted = unresolved.filter(isGenuinelyUnattempted);
    const neverAttemptedIds = new Set(neverAttempted.map((lead) => lead.id));
    const interruptedWithoutTimestamp = unresolved.filter(
      (lead) => !lead.lastScannedAt && !neverAttemptedIds.has(lead.id)
    );

    // Un riavvio può lasciare lastScannedAt nullo su un caso già avviato.
    // Lo parcheggiamo prima dello stream, altrimenti verrebbe scambiato per
    // un nuovo lead e sottrarrebbe continuamente spazio ai candidati migliori.
    if (interruptedWithoutTimestamp.length > 0) {
      await prisma.lead.updateMany({
        where: { id: { in: interruptedWithoutTimestamp.map((lead) => lead.id) } },
        data: { lastScannedAt: new Date() },
      });
    }

    if (neverAttempted.length === 0) {
      const completedButUnresolved = unresolved.filter(
        (lead) => !neverAttemptedIds.has(lead.id)
      );
      const maxAutomaticRetries = Math.max(
        1,
        Number(process.env.TERRITORY_MAX_AUTOMATIC_RETRIES || 12)
      );
      const retryableUnresolved = completedButUnresolved.filter(
        (lead) =>
          isAutomaticallyRetryable(lead) &&
          (retryAttempts.get(lead.id) || 0) <
            automaticRetryLimit(lead, maxAutomaticRetries)
      );
      if (retryableUnresolved.length === 0) {
        structuresScanned = attemptedIds.size;
        update({
          // Tutte le strutture sono state prese in carico e i casi non sicuri
          // restano esplicitamente non pubblicati: il job e concluso, non annullato.
          status: "completed",
          pid: null,
          finishedAt: new Date().toISOString(),
          progress: {
            municipalitiesCompleted: selectedCities.length,
            municipalitiesTotal: selectedCities.length,
            structuresFound,
            structuresScanned,
            certifiedResults,
            unresolvedResults: unresolved.length,
            currentMunicipality: null,
            message:
              `Scansione automatica completata: ${certifiedResults} risultati certificati; ` +
              `${unresolved.length} casi non pubblicati perche le fonti non consentono un esito sicuro.`,
          },
        });
        return;
      }
      const retryBatchSize = Math.max(
        1,
        // Un sito enorme non deve trattenere per ore il risultato di un lead
        // quasi concluso. I primi tentativi discovery restano concorrenti; i
        // completamenti automatici vengono invece chiusi in ordine di priorita.
        Number(process.env.TERRITORY_RETRY_BATCH || 1)
      );
      const selectedForRetry = [...retryableUnresolved]
        .sort((a, b) => {
          const attemptsDiff =
            (retryAttempts.get(a.id) || 0) - (retryAttempts.get(b.id) || 0);
          return (
            attemptsDiff ||
            retryPriority(a) - retryPriority(b) ||
            estimatedFrontierSize(a) - estimatedFrontierSize(b)
          );
        })
        .slice(0, retryBatchSize);
      forceFreshResolution = selectedForRetry.some(requiresFreshWebsiteResolution);
      for (const lead of selectedForRetry) {
        attemptedIds.add(lead.id);
        retryAttempts.set(lead.id, (retryAttempts.get(lead.id) || 0) + 1);
        await prisma.lead.update({
          where: { id: lead.id },
          data: {
            lastScannedAt: null,
            evidence: resumableEvidence(lead.evidence),
          },
        });
      }
    }

    structuresScanned = attemptedIds.size;
    continuationRound++;
    process.env.REVALIDATE_RETRY_STRATEGY =
      forceFreshResolution
        ? "fresh"
        : continuationRound % 4 === 0
        ? "rediscover"
        : continuationRound % 6 === 0
          ? "fresh"
          : "resume";
    update({
      status: "running",
      progress: {
        structuresFound,
        structuresScanned,
        certifiedResults,
        currentMunicipality: job.municipality,
        message:
          continuationRound === 1
            ? "Scansione certificata dei siti in corso."
            : `Completamento automatico pagine e documenti — round ${continuationRound}.`,
      },
    });

    await runStreamingScan(
      {
        region: job.region,
        city: job.municipality,
        continueAnalysis: continuationRound > 1,
        skipDiscovery: true,
        skipDedupe: continuationRound > 1,
      },
      (event, data) => {
        if (typeof data.processingId === "string") {
          activeProcessingLeadId = data.processingId;
        }
        if (event === "lead") {
          const lead = data.lead;
          if (lead && typeof lead === "object" && typeof lead.id === "string") {
            attemptedIds.add(lead.id);
          }
          const processingState =
            lead && typeof lead === "object" && lead.semantic
              ? lead.semantic.processingState
              : null;
          if (
            typeof processingState === "string" &&
            (processingState.startsWith("PUBLISHED_") ||
              processingState === "HOT_VERIFIED" ||
              processingState === "SELF_INSURANCE_VERIFIED")
          ) {
            certifiedResults++;
          }
        }
        if (event === "progress" || event === "lead") {
          const activeFrontier =
            typeof data.processingId === "string"
              ? {
                  frontierLeadId: data.processingId,
                  frontierState: "STARTING",
                  frontierCheckpoint: "Preparazione scansione sito",
                  frontierCompleted: 0,
                  frontierTotal: 0,
                  frontierPending: 0,
                  frontierFailed: 0,
                  frontierLastProgressAt: new Date().toISOString(),
                  frontierStalled: false,
                }
              : {};
          const done = Number(data.done);
          if (Number.isFinite(done)) {
            structuresScanned = Math.max(structuresScanned, attemptedIds.size, done);
          }
          update({
            status: "running",
            progress: {
              ...activeFrontier,
              structuresFound,
              structuresScanned,
              certifiedResults,
              currentMunicipality: job.municipality,
              message:
                typeof data.processingName === "string"
                  ? `Scansione: ${data.processingName}`
                  : "Scansione certificata dei siti in corso.",
            },
          });
        }
      }
    );

    const roundLeads = await prisma.lead.findMany({
      where: scanWhere,
      select: { id: true, evidence: true, lastScannedAt: true },
    });
    for (const lead of roundLeads) {
      if (lead.lastScannedAt) attemptedIds.add(lead.id);
    }
    structuresScanned = attemptedIds.size;
    certifiedResults = roundLeads.filter((lead) => {
      const state = readProcessingState(lead.evidence);
      return isCertifiedState(state) && state !== "OUT_OF_SCOPE";
    }).length;
    update({
      status: "running",
      progress: { structuresFound, structuresScanned, certifiedResults },
    });
    await delay(1_000);
  }

  update({
    status: "completed",
    pid: null,
    finishedAt: new Date().toISOString(),
    progress: {
      municipalitiesCompleted: selectedCities.length,
      municipalitiesTotal: selectedCities.length,
      newStructuresAdded: Math.max(0, afterTotal - beforeTotal),
      structuresFound,
      structuresScanned,
      certifiedResults,
      currentMunicipality: null,
      message: "Scansione territorio completata.",
    },
  });
}

try {
  await run();
  clearInterval(heartbeatTimer);
  resumeArchiveEngine();
  await terminateOcrWorker().catch(() => {});
  await closeMapsBrowserPool().catch(() => {});
  await prisma.$disconnect();
  process.exit(0);
} catch (error) {
  clearInterval(heartbeatTimer);
  try {
    resumeArchiveEngine();
  } catch {
    /* best effort: il controllo UI puo comunque riprendere l'archivio */
  }
  await terminateOcrWorker().catch(() => {});
  await closeMapsBrowserPool().catch(() => {});
  update({
    status: "failed",
    pid: null,
    finishedAt: new Date().toISOString(),
    errorMessage: error instanceof Error ? error.message : String(error),
    progress: {
      message: "Scansione territorio interrotta senza produrre classificazioni incerte.",
      currentMunicipality: null,
    },
  });
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
}
