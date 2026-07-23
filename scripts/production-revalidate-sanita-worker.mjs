/**
 * Isolated single-lead single-pass worker. NEVER imported by parent as analyzeLead.
 * Env:
 *   REVALIDATE_LEAD_ID, REVALIDATE_PASS, DATABASE_URL, FRONTIER_DB_PATH,
 *   SHADOW_RUN_ID, REVALIDATE_OUT, GIT_HEAD/RELEASE_SHA, OCR_*, etc.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { writeResultAtomic } from "./revalidate-checkpoint-v3.mjs";

const leadId = process.env.REVALIDATE_LEAD_ID;
const passLabel = process.env.REVALIDATE_PASS || "p1";
const outPath = process.env.REVALIDATE_OUT;
const wallMs = Math.max(60_000, Number(process.env.REVALIDATE_LEAD_WALL_MS || 45 * 60_000));
const stage = process.env.REVALIDATE_STAGE || "full"; // scope|full

if (!leadId || !outPath || !process.env.DATABASE_URL) {
  console.error("REVALIDATE_LEAD_ID, REVALIDATE_OUT, DATABASE_URL required");
  process.exit(2);
}
if (/\/opt\/leadsniper\/prisma\/dev\.db/i.test(process.env.DATABASE_URL) && process.env.ALLOW_LIVE_REVALIDATE !== "1") {
  console.error("Refusing live DB");
  process.exit(2);
}

process.env.STAGING_MODE = process.env.STAGING_MODE ?? "true";
process.env.DISABLE_LIVE_DB = "true";
process.env.DISABLE_EMAILS = "true";
process.env.SCAN_ENGINE_LOCAL = "1";
process.env.OCR_ENABLED = process.env.OCR_ENABLED ?? "1";
process.env.POLICY_EXHAUSTIVE = "1";
process.env.SCAN_FAST = "0";
delete process.env.SCAN_FAST;
// RC-07 — without this, analyzeLead early-returns on legacy [V:PUB]+policyFound
// (wallMs≈20–40ms, no crawl) and the coordinator demotes to RETRY_PENDING because
// evidence lacks [STATE:]/[BV:] stamps. sanita-job-runner already sets this; the
// isolated revalidate worker must too or Published known leads never re-verify.
// Finalize-resume: keep existing frontier, do not force homepage rediscovery.
if (process.env.REVALIDATE_FINALIZE_RESUME === "1") {
  process.env.FORCE_RESCAN_PUB = process.env.FORCE_RESCAN_PUB || "0";
} else {
  process.env.FORCE_RESCAN_PUB = process.env.FORCE_RESCAN_PUB || "1";
}

const testedCodeSha = (process.env.GIT_HEAD || process.env.RELEASE_SHA || "").trim() || null;
const runId = process.env.SHADOW_RUN_ID || `reval-${passLabel}-${leadId}-${Date.now()}`;
process.env.SHADOW_RUN_ID = runId;
if (!process.env.FRONTIER_DB_PATH) {
  console.error("FRONTIER_DB_PATH required (unique per worker)");
  process.exit(2);
}

const { prisma } = await import("../src/lib/prisma.ts");
const { analyzeLead } = await import("../src/lib/sanita/scan-engine.ts");
const { readVerdictToken } = await import("../src/lib/sanita/verdict.ts");
const { readProcessingState, readBusinessVerdict, readValidationStatus } = await import(
  "../src/lib/sanita/processing-state.ts"
);
const { classifyGelliScope } = await import("../src/lib/sanita/gelli-scope.ts");
const { openFrontierStore } = await import("../src/lib/sanita/frontier-store.ts");

function emptyCounters() {
  return {
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
}

function snapshotHash(lead) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        id: lead.id,
        companyName: lead.companyName,
        website: lead.website,
        evidence: lead.evidence,
        status: lead.status,
        notes: lead.notes,
        policyFound: lead.policyFound,
        policyCompany: lead.policyCompany,
        policyExpiry: lead.policyExpiry,
        policyNumber: lead.policyNumber,
      })
    )
    .digest("hex");
}

const lead = await prisma.lead.findUnique({ where: { id: leadId } });
if (!lead) {
  console.error(JSON.stringify({ event: "lead_missing", id: leadId }));
  process.exit(3);
}

const inputSnapshotHash = snapshotHash(lead);
const oldEvidence = lead.evidence || "";
const t0 = Date.now();
let error = null;
let scopeOnly = false;

// STAGE A — scope short-circuit (no full crawl when hard out of scope)
const scope = classifyGelliScope(lead.companyName, lead.category, lead.osmId);
if (stage === "scope" || (!scope.ok && /PUBLIC|SOLO_PROFESSIONISTA|HARD_EXCLUDE|FARMACIA|VETERINAR|NON_SANITAR/i.test(scope.reason))) {
  if (!scope.ok) {
    scopeOnly = true;
    const row = {
      id: lead.id,
      schemaVersion: 3,
      testedCodeSha,
      inputSnapshotHash,
      originalLiveSnapshotHash: inputSnapshotHash,
      companyName: lead.companyName,
      region: lead.region,
      city: lead.city,
      category: lead.category,
      crmStatus: lead.status,
      notes: lead.notes,
      oldVerdict: readVerdictToken(oldEvidence),
      newVerdict: null,
      processingState: "OUT_OF_SCOPE",
      businessVerdict: "OUT_OF_SCOPE",
      validationStatus: null,
      fullEvidence: oldEvidence + `\n[STATE:OUT_OF_SCOPE][BV:OUT_OF_SCOPE][SCOPE:${scope.reason}]`,
      token: null,
      website: lead.website,
      websiteReachable: null,
      policyFound: lead.policyFound,
      policyCompany: lead.policyCompany,
      policyNumber: lead.policyNumber,
      policyExpiry: lead.policyExpiry ? new Date(lead.policyExpiry).toISOString() : null,
      policyMassimale: lead.policyMassimale ?? null,
      confidence: lead.confidence ?? null,
      pagesVisited: lead.pagesVisited ?? null,
      leadScore: lead.leadScore ?? null,
      phone: lead.phone,
      email: lead.email,
      pec: lead.pec,
      piva: lead.piva,
      lastScannedAt: new Date().toISOString(),
      scope: { ok: false, reason: scope.reason },
      sourceLineage: lead.osmId || null,
      runIds: [runId],
      frontierPaths: [process.env.FRONTIER_DB_PATH],
      passLabel,
      pass1: null,
      pass2: null,
      dualDisagreement: false,
      terminal: true,
      reasonCode: "OUT_OF_SCOPE",
      wallMs: Date.now() - t0,
      finishedAt: new Date().toISOString(),
    };
    writeResultAtomic(outPath, row);
    console.log(JSON.stringify({ event: "worker_done", id: leadId, processingState: "OUT_OF_SCOPE" }));
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  }
}

// Graceful SIGTERM (k3 RC-04 — root cause dimostrata: chrome-headless orfani e
// requeue "orphan_after_sigterm_graceful_stop" nello stop systemd del 2026-07-21).
// Scrive SEMPRE una riga risultato operativa (RETRY_PENDING, frontier preservata)
// ed esce pulito: niente processi appesi, niente requeue implicito non diagnosticato.
let sigtermHandled = false;
process.on("SIGTERM", () => {
  if (sigtermHandled) return;
  sigtermHandled = true;
  const row = {
    id: lead.id,
    schemaVersion: 3,
    testedCodeSha,
    inputSnapshotHash,
    originalLiveSnapshotHash: inputSnapshotHash,
    companyName: lead.companyName,
    region: lead.region,
    city: lead.city,
    category: lead.category,
    crmStatus: lead.status,
    notes: lead.notes,
    oldVerdict: readVerdictToken(oldEvidence),
    newVerdict: null,
    processingState: "RETRY_PENDING",
    businessVerdict: null,
    validationStatus: null,
    fullEvidence: `${oldEvidence}\n[WORKER_SIGTERM: graceful stop — frontier preserved, nodes recoverable at resume]`,
    token: null,
    crawlComplete: false,
    website: lead.website,
    websiteReachable: null,
    policyFound: null,
    policyCompany: null,
    policyNumber: null,
    policyExpiry: null,
    policyMassimale: null,
    confidence: null,
    pagesVisited: null,
    leadScore: null,
    phone: lead.phone,
    email: lead.email,
    pec: lead.pec,
    piva: lead.piva,
    lastScannedAt: new Date().toISOString(),
    scope: { ok: scope.ok, reason: scope.reason },
    sourceLineage: lead.osmId || null,
    runIds: [runId],
    frontierPaths: [process.env.FRONTIER_DB_PATH],
    passLabel,
    wallMs: Date.now() - t0,
    finishedAt: new Date().toISOString(),
    error: "WORKER_SIGTERM",
  };
  try {
    writeResultAtomic(outPath, row);
  } catch {
    /* */
  }
  console.log(JSON.stringify({ event: "worker_sigterm", id: leadId, wallMs: row.wallMs }));
  setTimeout(() => process.exit(0), 3000).unref();
  prisma
    .$disconnect()
    .catch(() => {})
    .finally(() => process.exit(0));
});

openFrontierStore(process.env.FRONTIER_DB_PATH);
const counters = emptyCounters();
let currentStage = "init";
let failingUrl = null;
let failingNodeId = null;
let errorClass = null;
let stackSynth = null;

function isCommercialStamp(ps) {
  return /^(HOT_VERIFIED|PUBLISHED_|SELF_INSURANCE_VERIFIED|REVIEW_HUMAN|OUT_OF_SCOPE)/.test(String(ps || ""));
}

try {
  currentStage = "analyzeLead";
  await Promise.race([
    analyzeLead(
      {
        id: lead.id,
        osmId: lead.osmId,
        category: lead.category,
        companyName: lead.companyName,
        city: lead.city,
        region: lead.region,
        website: lead.website,
        phone: lead.phone,
        email: lead.email,
        pec: lead.pec,
        piva: lead.piva,
      },
      counters
    ),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`LEAD_WALL_TIMEOUT_${wallMs}ms`)), wallMs)
    ),
  ]);
  currentStage = "analyzeLead_done";
} catch (e) {
  error = e instanceof Error ? e.message : String(e);
  stackSynth = e instanceof Error ? String(e.stack || "").split("\n").slice(0, 6).join(" | ") : null;
  if (/LEAD_WALL_TIMEOUT/i.test(error)) errorClass = "LEAD_WALL_TIMEOUT";
  else if (/Executable doesn't exist|browserType\.launch|playwright/i.test(error))
    errorClass = "PLAYWRIGHT_BROWSER_MISSING";
  else if (/ENOTFOUND|NXDOMAIN|getaddrinfo|EAI_AGAIN/i.test(error)) errorClass = "DNS_OR_NETWORK";
  else if (/CERT_|SSL_|TLS|UNABLE_TO_VERIFY/i.test(error)) errorClass = "TLS_FAILURE";
  else if (/OCR_|pdftoppm|tesseract/i.test(error)) errorClass = "OCR_FAILURE";
  else errorClass = "ANALYZE_EXCEPTION";
  currentStage = `catch:${errorClass}`;
}

const { frontierDiagnosticSummary, listNodes } = await import("../src/lib/sanita/frontier-store.ts");
let frontierSummary = null;
let ocrStatus = null;
try {
  // FRONTIER_DB_PATH store already open — crawlRunId == SHADOW_RUN_ID typically
  const nodes = listNodes(runId);
  const mid = nodes.find((n) => ["FETCHED", "PARSED", "FETCHING", "RETRY_PENDING"].includes(n.state));
  if (mid) {
    failingUrl = mid.canonicalUrl;
    failingNodeId = mid.id;
  }
  frontierSummary = frontierDiagnosticSummary(runId);
  const evOcr = nodes.filter((n) => n.resourceType === "pdf" || /\.pdf/i.test(n.canonicalUrl));
  ocrStatus = {
    pdfFound: evOcr.length,
    pdfCompleted: evOcr.filter((n) => n.state === "COMPLETED").length,
    pdfRetry: evOcr.filter((n) => n.state === "RETRY_PENDING").length,
    pdfBlocked: evOcr.filter((n) => n.state === "TECHNICAL_BLOCKED").length,
  };
} catch {
  frontierSummary = { error: "frontier_summary_failed" };
}

const after = await prisma.lead.findUnique({ where: { id: leadId } });
const evidence = after?.evidence || "";
const token = readVerdictToken(evidence);
const businessVerdict = readBusinessVerdict(evidence);
const validationStatus = readValidationStatus(evidence);
const { acceptCanonicalPublishedTerminal } = await import("../src/lib/sanita/canonical-published-terminal.ts");

// Coordinator reads analyzeLead stamps only — never invent PUBLISHED from prose/regex.
let finalState = error ? "RETRY_PENDING" : readProcessingState(evidence) || null;

if (error) {
  // Playwright missing must not wipe a stamped commercial terminal from the same run.
  const stamped = readProcessingState(evidence);
  if (
    errorClass === "PLAYWRIGHT_BROWSER_MISSING" &&
    stamped &&
    stamped !== "RETRY_PENDING" &&
    isCommercialStamp(stamped)
  ) {
    finalState = stamped;
    error = null; // recoverable infra — stamp wins
    errorClass = "PLAYWRIGHT_BROWSER_MISSING_RECOVERED";
  } else {
    finalState = "RETRY_PENDING";
  }
} else {
  const pubAccept = acceptCanonicalPublishedTerminal({
    token,
    businessVerdict,
    processingState: finalState,
    policyFound: after?.policyFound,
    policyExpiry: after?.policyExpiry ?? null,
    evidence,
    workerError: null,
    runAt: new Date(),
  });
  if (pubAccept.ok) {
    finalState = pubAccept.processingState;
  } else if (finalState && String(finalState).startsWith("PUBLISHED")) {
    finalState = "RETRY_PENDING";
  } else if (!finalState && token === "HOT" && /\[CRAWL_COMPLETE:true\]/i.test(evidence)) {
    finalState = "HOT_VERIFIED";
  } else if (!finalState) {
    finalState = "RETRY_PENDING";
  }
}

let reasonCode = finalState;
if (error) {
  if (errorClass === "LEAD_WALL_TIMEOUT") reasonCode = "LEAD_WALL_TIMEOUT";
  else if (errorClass === "PLAYWRIGHT_BROWSER_MISSING") reasonCode = "PLAYWRIGHT_BROWSER_MISSING";
  else if (errorClass === "DNS_OR_NETWORK") reasonCode = "DNS_OR_NETWORK";
  else if (errorClass === "TLS_FAILURE") reasonCode = "TLS_FAILURE";
  else if (errorClass === "OCR_FAILURE") reasonCode = "OCR_FAILURE";
  else reasonCode = "ANALYZE_EXCEPTION";
} else if (finalState === "RETRY_PENDING") {
  if (/Contaminazione critica|sito errato|IDENTITY:MISMATCH/i.test(evidence)) {
    finalState = "REVIEW_HUMAN";
    reasonCode = "IDENTITY_MISMATCH";
  } else if (/PDF non processati/i.test(evidence)) reasonCode = "PDF_UNPROCESSED";
  else if (/cap URL|cap tempo|URL_CAP|RUN_WALL_CLOCK/i.test(evidence)) reasonCode = "CRAWL_CAP";
  else if (/sitemap|ROBOTS_REFERENCED_FAILED|DISCOVERED_FAILED/i.test(evidence)) reasonCode = "SITEMAP_UNRESOLVED";
  else if (/coda HTML non esaurita|link rilevanti non tutti/i.test(evidence)) reasonCode = "FRONTIER_INCOMPLETE";
  else if (
    /\[CRAWL_COMPLETE:true\]/i.test(evidence) &&
    /Assenza polizza certificata/i.test(evidence) &&
    /IDENTITY:OFFICIAL/i.test(evidence)
  ) {
    // Exhausted frontier + absence certified but stamp missing → HOT
    finalState = "HOT_VERIFIED";
    reasonCode = "HOT_VERIFIED";
  } else reasonCode = "RETRY_PENDING";
}

// Honest terminals (NOT false HOT/PUB/SI): crawl exhausted but commercial HOT impossible.
if (!error && finalState === "RETRY_PENDING") {
  const crawlDone = /\[CRAWL_COMPLETE:true\]/i.test(evidence) || /FRONTIER:EXHAUSTED/i.test(evidence);
  const thinSite = /pagine insufficienti\s*\(\d+\/12\)/i.test(evidence);
  const absenceOk = /Assenza polizza certificata/i.test(evidence);
  const crossDomainPolicy = /PDF polizza su dominio diverso/i.test(evidence);
  if (crawlDone && thinSite && absenceOk) {
    finalState = "REVIEW_HUMAN";
    reasonCode = "EXTERNAL_SITE_TOO_THIN";
  } else if (crawlDone && crossDomainPolicy) {
    finalState = "REVIEW_HUMAN";
    reasonCode = "POLICY_CROSS_DOMAIN";
  } else if (crawlDone && absenceOk && /IDENTITY:OFFICIAL/i.test(evidence) && token === "HOT") {
    finalState = "HOT_VERIFIED";
    reasonCode = "HOT_VERIFIED";
  }
}

// Never override canonical token/BV — only echo analyzeLead
const outToken = token;
const outBv =
  finalState === "HOT_VERIFIED"
    ? "HOT_VERIFIED"
    : finalState === "REVIEW_HUMAN"
      ? "REVIEW_HUMAN"
      : finalState === "OUT_OF_SCOPE"
        ? "OUT_OF_SCOPE"
        : businessVerdict;

const row = {
  id: lead.id,
  schemaVersion: 3,
  testedCodeSha,
  inputSnapshotHash,
  originalLiveSnapshotHash: inputSnapshotHash,
  companyName: lead.companyName,
  region: lead.region,
  city: lead.city,
  category: lead.category,
  crmStatus: lead.status,
  notes: lead.notes,
  oldVerdict: readVerdictToken(oldEvidence),
  newVerdict: outToken,
  processingState: finalState,
  businessVerdict: outBv,
  validationStatus,
  fullEvidence: evidence,
  token: outToken,
  crawlComplete: /\[CRAWL_COMPLETE:true\]/i.test(evidence),
  website: after?.website ?? lead.website,
  websiteReachable: after?.websiteReachable ?? null,
  policyFound: after?.policyFound ?? null,
  policyCompany: after?.policyCompany ?? null,
  policyNumber: after?.policyNumber ?? null,
  policyExpiry: after?.policyExpiry ? new Date(after.policyExpiry).toISOString() : null,
  policyMassimale: after?.policyMassimale ?? null,
  confidence: after?.confidence ?? null,
  pagesVisited: after?.pagesVisited ?? null,
  leadScore: after?.leadScore ?? null,
  phone: after?.phone ?? lead.phone,
  email: after?.email ?? lead.email,
  pec: after?.pec ?? lead.pec,
  piva: after?.piva ?? lead.piva,
  lastScannedAt: new Date().toISOString(),
  scope: { ok: scope.ok, reason: scope.reason },
  sourceLineage: lead.osmId || null,
  runIds: [runId],
  frontierPaths: [process.env.FRONTIER_DB_PATH],
  passLabel,
  pass1:
    passLabel === "p1"
      ? {
          runId,
          frontierPath: process.env.FRONTIER_DB_PATH,
          wallMs: Date.now() - t0,
          error,
          token: outToken,
          processingState: finalState,
          crawlComplete: /\[CRAWL_COMPLETE:true\]/i.test(evidence),
          policyFound: after?.policyFound ?? null,
        }
      : null,
  pass2:
    passLabel === "p2"
      ? {
          runId,
          frontierPath: process.env.FRONTIER_DB_PATH,
          wallMs: Date.now() - t0,
          error,
          token: outToken,
          processingState: finalState,
          crawlComplete: /\[CRAWL_COMPLETE:true\]/i.test(evidence),
          policyFound: after?.policyFound ?? null,
        }
      : null,
  dualDisagreement: false,
  terminal: !error && finalState !== "RETRY_PENDING",
  reasonCode,
  wallMs: Date.now() - t0,
  finishedAt: new Date().toISOString(),
  error,
  counters,
  // STOP-SHIP diagnostics — never leave ANALYZE opaque
  stage: currentStage,
  errorClass,
  failingUrl,
  failingNodeId,
  stackSynth,
  ocrStatus,
  frontierSummary,
};

writeResultAtomic(outPath, row);
console.log(
  JSON.stringify({
    event: "worker_done",
    id: leadId,
    passLabel,
    processingState: finalState,
    wallMs: row.wallMs,
    error: Boolean(error),
    errorClass,
    stage: currentStage,
    reasonCode,
  })
);
await prisma.$disconnect().catch(() => {});
process.exit(error ? 10 : 0);
