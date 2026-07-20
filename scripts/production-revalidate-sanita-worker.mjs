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

openFrontierStore(process.env.FRONTIER_DB_PATH);
const counters = emptyCounters();

try {
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
} catch (e) {
  error = e instanceof Error ? e.message : String(e);
}

const after = await prisma.lead.findUnique({ where: { id: leadId } });
const evidence = after?.evidence || "";
const processingState = error
  ? "RETRY_PENDING"
  : readProcessingState(evidence) || (readVerdictToken(evidence) === "HOT" ? null : null);
const token = readVerdictToken(evidence);
const businessVerdict = readBusinessVerdict(evidence);
const validationStatus = readValidationStatus(evidence);

let finalState = processingState;
if (error) finalState = "RETRY_PENDING";
else if (!finalState && token === "HOT" && /\[CRAWL_COMPLETE:true\]/i.test(evidence)) finalState = "HOT_VERIFIED";
else if (!finalState && token === "PUBLISHED") finalState = businessVerdict || "PUBLISHED_DATE_UNKNOWN";
else if (!finalState) finalState = "RETRY_PENDING";

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
  newVerdict: token,
  processingState: finalState,
  businessVerdict,
  validationStatus,
  fullEvidence: evidence,
  token,
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
          token,
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
          token,
          processingState: finalState,
          crawlComplete: /\[CRAWL_COMPLETE:true\]/i.test(evidence),
          policyFound: after?.policyFound ?? null,
        }
      : null,
  dualDisagreement: false,
  terminal: !error && finalState !== "RETRY_PENDING",
  reasonCode: error ? "ANALYZE_ERROR_OR_TIMEOUT" : finalState,
  wallMs: Date.now() - t0,
  finishedAt: new Date().toISOString(),
  error,
  counters,
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
  })
);
await prisma.$disconnect().catch(() => {});
process.exit(error ? 10 : 0);
