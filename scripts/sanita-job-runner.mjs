import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import {
  readSanitaJob,
  writeSanitaJob,
} from "@/lib/sanita/jobs";
import { runStreamingScan } from "@/lib/sanita/scan-stream";
import { serializeLeadForClient } from "@/lib/sanita/lead-serialize";
import { readBusinessVerdict, readProcessingState } from "@/lib/sanita/processing-state";
import { isInActionableSalesQueue } from "@/lib/sanita/actionable-queue";
import {
  SANITA_JOB_LEAD_MAX_MS,
  markLeadJobIncomplete,
  runWithJobLeadTimeout,
  startJobHeartbeat,
  writeJobCheckpoint,
} from "@/lib/sanita/job-watchdog";
import { applyCertifiedFromJobLead } from "@/lib/sanita/job-certified-apply";
import { runPublishedPriorityForJob } from "@/lib/sanita/job-published-priority";

const jobId = process.argv[2];
if (!jobId) {
  console.error("jobId required");
  process.exit(2);
}

const job = readSanitaJob(jobId);
if (!job) {
  console.error(`job ${jobId} not found`);
  process.exit(2);
}

// Frontier SQLite must live outside /opt/leadsniper (assertSafePath blocks production tree).
const frontierDir =
  process.env.SANITA_JOB_FRONTIER_DIR || join("/tmp", "leadsniper-sanita-job-frontier");
mkdirSync(frontierDir, { recursive: true });
process.env.FRONTIER_DB_PATH = join(frontierDir, `${jobId}.sqlite`);
process.env.SHADOW_RUN_ID = jobId;

let stopped = false;

function isCertifiedLead(lead) {
  const ps = lead?.semantic?.processingState ?? readProcessingState(lead?.evidence ?? null);
  const bv = lead?.semantic?.businessVerdict ?? readBusinessVerdict(lead?.evidence ?? null);
  if (ps === "HOT_VERIFIED") return true;
  return (
    ps === "PUBLISHED_CURRENT" ||
    ps === "PUBLISHED_EXPIRED" ||
    ps === "PUBLISHED_DATE_UNKNOWN" ||
    bv === "PUBLISHED_CURRENT" ||
    bv === "PUBLISHED_EXPIRED" ||
    bv === "PUBLISHED_DATE_UNKNOWN" ||
    Boolean(lead?.semantic?.actionable ?? lead?._actionable ?? isInActionableSalesQueue(lead))
  );
}

function applyState(patch) {
  const current = readSanitaJob(jobId);
  if (!current) return null;
  const next = {
    ...current,
    ...patch,
    progress: {
      ...current.progress,
      ...(patch.progress || {}),
    },
  };
  return writeSanitaJob(next);
}

function stopSignal(status, message) {
  stopped = true;
  applyState({
    status,
    finishedAt: new Date().toISOString(),
    resumable: status !== "completed" && status !== "cancelled",
    pid: null,
    lastUpdateLabel: status === "cancelled" ? "Interrotto" : status === "failed" ? "Errore" : "Completato",
    progress: {
      currentMessage: message,
      currentStructure: null,
    },
  });
}

process.on("SIGTERM", () => {
  stopSignal("cancelled", "Job interrotto dall'operatore.");
  process.exit(130);
});
process.on("SIGINT", () => {
  stopSignal("cancelled", "Job interrotto dall'operatore.");
  process.exit(130);
});

applyState({
  status: "running",
  startedAt: new Date().toISOString(),
  pid: process.pid,
  resumable: true,
  lastUpdateLabel: "Verifica in corso",
  progress: {
    currentMessage: "Preparazione del controllo.",
  },
});

async function ensureNotCancelled() {
  const fresh = readSanitaJob(jobId);
  if (fresh?.cancelRequested) {
    stopSignal("cancelled", "Job interrotto.");
    process.exit(130);
  }
}

async function analyzeLeadWithWatchdog(lead, counters, opts = {}) {
  const leadMaxMs = Number(process.env.SANITA_JOB_LEAD_MAX_MS || SANITA_JOB_LEAD_MAX_MS || 0);
  const stopHeartbeat = startJobHeartbeat(jobId, () => ({
    currentStructure: lead.companyName,
    currentMessage: opts.message || "Verifica in corso.",
  }));
  try {
    const { analyzeLead } = await import("@/lib/sanita/scan-engine");
    await runWithJobLeadTimeout(() => analyzeLead(lead, counters), leadMaxMs);
    return { timedOut: false };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/Verifica non completata entro/i.test(msg)) {
      await markLeadJobIncomplete(lead.id, msg, { retriesExhausted: true });
      return { timedOut: true, message: msg };
    }
    throw error;
  } finally {
    stopHeartbeat();
    const { terminateOcrWorker } = await import("@/lib/sanita/ocr");
    const { closeMapsBrowserPool } = await import("@/lib/sanita/playwright-maps");
    await terminateOcrWorker().catch(() => {});
    await closeMapsBrowserPool().catch(() => {});
  }
}

async function runSingleLead() {
  const lead = await prisma.lead.findUnique({ where: { id: job.leadId || "" } });
  if (!lead) throw new Error("Lead non trovato");

  if (job.forceRescan) {
    process.env.FORCE_RESCAN_PUB = "1";
  }

  try {
    await ensureNotCancelled();
    applyState({
      progress: {
        structuresControlled: 0,
        totalStructures: 1,
        percent: 0,
        currentStructure: lead.companyName,
        currentMessage: "Verifica in corso sulla struttura selezionata.",
      },
    });
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
    };

    let analysis = { timedOut: false };
    const pubPriority =
      job.forceRescan && /\[DOCS:/i.test(lead.evidence || "")
        ? await runPublishedPriorityForJob(lead)
        : { handled: false };

    if (pubPriority.handled) {
      counters.analyzed++;
      if (pubPriority.policyFound) counters.withPolicy++;
      if (pubPriority.certified) counters.published++;
    } else {
      analysis = await analyzeLeadWithWatchdog(lead, counters, {
        message: "Verifica in corso sulla struttura selezionata.",
      });
    }

    const finalLead = await prisma.lead.findUnique({ where: { id: lead.id } });
    if (!finalLead) throw new Error("Lead non trovato dopo analisi");
    const clientLead = serializeLeadForClient(finalLead);
    let certifiedResults = isCertifiedLead(clientLead) ? 1 : 0;
    const ps = readProcessingState(finalLead.evidence);

    let applyResult = null;
    if (!analysis.timedOut && certifiedResults > 0) {
      applyResult = await applyCertifiedFromJobLead(lead.id, jobId);
    }

    const completed = applyState({
      status: "completed",
      finishedAt: new Date().toISOString(),
      resumable: false,
      pid: null,
      lastUpdateLabel: analysis.timedOut ? "Controllo necessario" : "Completato",
      progress: {
        structuresControlled: 1,
        totalStructures: 1,
        certifiedResults: analysis.timedOut ? 0 : certifiedResults,
        autoVerificationsPending:
          analysis.timedOut || ps === "RETRY_PENDING" || ps === "TECHNICAL_BLOCKED" ? 1 : 0,
        manualChecksNeeded: ps === "REVIEW_HUMAN" ? 1 : 0,
        percent: 100,
        currentStructure: finalLead.companyName,
        currentMessage: analysis.timedOut
          ? "Verifica non completata entro il limite. Riprova più tardi."
          : applyResult?.applied
            ? "Risultato certificato applicato."
            : "Controllo completato.",
      },
    });
    if (completed) writeJobCheckpoint(completed, { apply: applyResult, timedOut: analysis.timedOut });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const current = readSanitaJob(jobId);
    const failed = current
      ? applyState({
          status: "failed",
          finishedAt: new Date().toISOString(),
          resumable: true,
          pid: null,
          lastUpdateLabel: "Errore",
          errorMessage: msg,
          progress: {
            ...current.progress,
            currentMessage: "Errore durante il controllo.",
            currentStructure: null,
          },
        })
      : null;
    if (failed) writeJobCheckpoint(failed, { error: msg });
    throw error;
  }
}

async function runRegionCanary() {
  const targetTotal = Number(job.targetTotal ?? 3);
  const leadIds = Array.isArray(job.canaryLeadIds) ? job.canaryLeadIds : [];

  function stopShip(reason) {
    applyState({
      status: "failed",
      finishedAt: new Date().toISOString(),
      resumable: false,
      pid: null,
      lastUpdateLabel: "Errore",
      errorMessage: `STOP-SHIP: ${reason}`,
      progress: {
        currentMessage: `STOP-SHIP: ${reason}`,
        currentStructure: null,
      },
    });
    process.exit(2);
  }

  if (targetTotal > 3 || leadIds.length > 3) stopShip("targetTotal > 3");
  if ((job.processed ?? 0) > 0) stopShip("processed > 0 at start");
  if (job.resumedFrom != null) stopShip("resumedFrom not null");
  if (job.noResume !== true) stopShip("noResume not true");
  if (leadIds.length !== targetTotal) stopShip("leadIds count mismatch");

  if (job.forceRescan) {
    process.env.FORCE_RESCAN_PUB = "1";
  }

  const { terminateOcrWorker } = await import("@/lib/sanita/ocr");
  const { closeMapsBrowserPool } = await import("@/lib/sanita/playwright-maps");

  let processed = 0;
  let certifiedResults = 0;
  let autoVerificationsPending = 0;
  let manualChecksNeeded = 0;
  const analyzedLeads = [];

  try {
    applyState({
      progress: {
        structuresControlled: 0,
        totalStructures: targetTotal,
        percent: 0,
        currentMessage: "Controllo canary regionale (max 3 strutture).",
      },
    });

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
    };

    for (const lid of leadIds) {
      await ensureNotCancelled();
      const lead = await prisma.lead.findUnique({ where: { id: lid } });
      if (!lead) stopShip(`lead missing ${lid}`);
      if (!leadIds.includes(lead.id)) stopShip("lead outside canary set");

      applyState({
        progress: {
          currentStructure: lead.companyName,
          currentMessage: `Verifica in corso (${processed + 1}/${targetTotal}).`,
        },
      });

      const outcome = await analyzeLeadWithWatchdog(lead, counters, {
        message: `Verifica in corso (${processed + 1}/${targetTotal}).`,
      });
      processed++;

      const finalLead = await prisma.lead.findUnique({ where: { id: lid } });
      const clientLead = finalLead ? serializeLeadForClient(finalLead) : null;
      if (!outcome.timedOut && clientLead && isCertifiedLead(clientLead)) {
        await applyCertifiedFromJobLead(lid, jobId);
        certifiedResults++;
      }
      const ps = readProcessingState(finalLead?.evidence ?? null);
      if (ps === "RETRY_PENDING") autoVerificationsPending++;
      if (ps === "REVIEW_HUMAN") manualChecksNeeded++;

      analyzedLeads.push({
        id: lid,
        companyName: lead.companyName,
        city: lead.city,
        processingState: ps,
        certified: Boolean(clientLead && isCertifiedLead(clientLead)),
      });

      const percent = Math.round((processed / targetTotal) * 100);
      applyState({
        processed,
        progress: {
          structuresControlled: processed,
          totalStructures: targetTotal,
          certifiedResults,
          autoVerificationsPending,
          manualChecksNeeded,
          percent,
          currentStructure: lead.companyName,
          currentMessage:
            processed >= targetTotal
              ? "Controllo completato."
              : `Verifica in corso (${processed}/${targetTotal}).`,
        },
      });

      if (processed > targetTotal) stopShip("processed exceeded targetTotal");
    }

    applyState({
      status: "completed",
      finishedAt: new Date().toISOString(),
      resumable: false,
      pid: null,
      processed,
      lastUpdateLabel: "Completato",
      progress: {
        structuresControlled: processed,
        totalStructures: targetTotal,
        certifiedResults,
        autoVerificationsPending,
        manualChecksNeeded,
        percent: 100,
        currentStructure: null,
        currentMessage: "Controllo completato.",
      },
    });
  } finally {
    await terminateOcrWorker().catch(() => {});
    await closeMapsBrowserPool().catch(() => {});
  }
}

async function runRegionOrCity() {
  let certifiedResults = 0;
  let autoVerificationsPending = 0;
  let manualChecksNeeded = 0;
  let lastStructuresControlled = 0;
  let lastTotal = 0;
  const maxStructures = Math.max(0, Number(process.env.SANITA_JOB_MAX_STRUCTURES || 0)) || null;
  let canaryStop = false;
  let canaryAnalyzed = 0;

  function maybeStopCanary(reason) {
    if (!maxStructures || canaryStop) return;
    if (canaryAnalyzed >= maxStructures || lastStructuresControlled >= maxStructures) {
      canaryStop = true;
      applyState({
        status: "interrupted",
        finishedAt: new Date().toISOString(),
        resumable: true,
        pid: null,
        lastUpdateLabel: "Riprendibile",
        progress: {
          structuresControlled: lastStructuresControlled,
          totalStructures: lastTotal || null,
          certifiedResults,
          autoVerificationsPending,
          manualChecksNeeded,
          currentMessage: reason || `Limite canary (${maxStructures}) raggiunto — job riprendibile.`,
          currentStructure: null,
        },
      });
      process.exit(0);
    }
  }

  await runStreamingScan(
    {
      region: job.region,
      city: job.city,
      // ponytail: canary must not resume regional DB progress — only analyze next N fresh leads.
      continueAnalysis: maxStructures ? false : (job.progress?.structuresControlled || 0) > 0,
    },
    (event, data) => {
      const latest = readSanitaJob(jobId);
      if (latest?.cancelRequested) {
        stopSignal("cancelled", "Job interrotto.");
        process.exit(130);
      }

      if (event === "progress") {
        lastStructuresControlled = Number(data.done ?? lastStructuresControlled ?? 0);
        lastTotal = Number(data.total ?? lastTotal ?? 0);
        if (maxStructures && (lastTotal > maxStructures || lastTotal >= 553)) {
          stopSignal("failed", `STOP-SHIP: regional total ${lastTotal}`);
          process.exit(2);
        }
        const percent = lastTotal > 0 ? Math.max(0, Math.min(100, Math.round((lastStructuresControlled / lastTotal) * 100))) : null;
        const phase = typeof data.phase === "string" ? data.phase : null;
        // Ponytail: keep UI customer-friendly, never surface internal "crawl/discovery" wording.
        const currentMessage =
          phase === "discovery" ? "Scoperta strutture in corso." : "Verifica in corso.";
        applyState({
          lastUpdateLabel: "Verifica in corso",
          progress: {
            structuresControlled: lastStructuresControlled,
            totalStructures: lastTotal || null,
            certifiedResults,
            autoVerificationsPending,
            manualChecksNeeded,
            percent,
            currentStructure:
              typeof data.processingName === "string" ? data.processingName : (latest?.progress.currentStructure ?? null),
            currentMessage,
          },
        });
        maybeStopCanary(`Limite canary (${maxStructures}) raggiunto — job riprendibile.`);
      } else if (event === "lead" && data.lead && typeof data.lead === "object") {
        const lead = data.lead;
        canaryAnalyzed++;
        if (isCertifiedLead(lead)) certifiedResults++;
        const ps = lead.semantic?.processingState ?? readProcessingState(lead.evidence ?? null);
        if (ps === "RETRY_PENDING") autoVerificationsPending++;
        if (ps === "REVIEW_HUMAN") manualChecksNeeded++;
        applyState({
          progress: {
            certifiedResults,
            autoVerificationsPending,
            manualChecksNeeded,
            currentStructure: typeof lead.companyName === "string" ? lead.companyName : null,
          },
        });
        maybeStopCanary(`Limite canary (${maxStructures}) raggiunto — job riprendibile.`);
      } else if (event === "paused" || event === "complete") {
        const stats = (data.stats || {}) ;
        const structuresControlled = Number(stats.done ?? lastStructuresControlled ?? 0);
        const totalStructures = Number(stats.total ?? lastTotal ?? 0) || null;
        const complete = Boolean(stats.complete) || event === "complete";
        applyState({
          status: complete ? "completed" : "interrupted",
          finishedAt: new Date().toISOString(),
          resumable: !complete,
          pid: null,
          lastUpdateLabel: complete ? "Completato" : "Riprendibile",
          progress: {
            structuresControlled,
            totalStructures,
            certifiedResults,
            autoVerificationsPending,
            manualChecksNeeded,
            percent:
              totalStructures && totalStructures > 0
                ? Math.max(0, Math.min(100, Math.round((structuresControlled / totalStructures) * 100)))
                : null,
            currentStructure: null,
            currentMessage: complete
              ? "Controllo completato."
              : "Verifica sospesa: puo' essere ripresa senza perdere i risultati gia' salvati.",
          },
        });
      } else if (event === "error") {
        applyState({
          status: "failed",
          finishedAt: new Date().toISOString(),
          resumable: true,
          pid: null,
          errorMessage: typeof data.message === "string" ? data.message : "Errore interno",
          lastUpdateLabel: "Errore",
          progress: {
            currentMessage:
              "Errore durante il controllo. Riprova o riprendi il job.",
          },
        });
      }
    }
  );
}

try {
  if (job.mode === "single") await runSingleLead();
  else if (job.mode === "region-canary") await runRegionCanary();
  else await runRegionOrCity();
  await ensureNotCancelled();
  const finalJob = readSanitaJob(jobId);
  if (finalJob && finalJob.status === "running") {
    applyState({
      status: "completed",
      finishedAt: new Date().toISOString(),
      resumable: false,
      pid: null,
      lastUpdateLabel: "Completato",
      progress: {
        currentMessage: "Controllo completato.",
      },
    });
  }
  process.exit(0);
} catch (error) {
  if (!stopped) {
    applyState({
      status: "failed",
      finishedAt: new Date().toISOString(),
      resumable: true,
      pid: null,
      errorMessage: error instanceof Error ? error.message : String(error),
      lastUpdateLabel: "Errore",
      progress: {
        currentMessage:
          error instanceof Error ? error.message : "Errore durante il controllo.",
      },
    });
  }
  process.exit(1);
}
