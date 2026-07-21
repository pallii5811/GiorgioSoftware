/**
 * Progressive apply of ONE (or few) certified terminal results to live.
 * Does NOT require 877/877 complete.
 *
 * Env:
 *   APPLY_IDS=id1,id2
 *   REVALIDATE_RESULTS_DIR=...
 *   APPLY_LIVE=1 (default dry-run)
 *   BACKUP_META_PATH=... (required if APPLY_LIVE=1)
 *   LIVE_DATABASE_URL=file:/opt/leadsniper/prisma/dev.db
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { validateCertifiedApplyRow } from "../src/lib/sanita/apply-certified-terminal.ts";
import { openFrontierStore } from "../src/lib/sanita/frontier-store.ts";

const RESULTS_DIR =
  process.env.REVALIDATE_RESULTS_DIR || path.join(process.cwd(), "data/revalidation/results");
const APPLY_LIVE = process.env.APPLY_LIVE === "1";
const BACKUP_META = process.env.BACKUP_META_PATH;
const LIVE_URL = process.env.LIVE_DATABASE_URL || (APPLY_LIVE ? process.env.DATABASE_URL : null);
const ids = (process.env.APPLY_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const frontierPath =
  process.env.FRONTIER_DB_PATH || path.join(process.cwd(), "data/crawl-frontier.db");
if (fs.existsSync(frontierPath)) {
  try {
    openFrontierStore(frontierPath);
  } catch (e) {
    console.error(JSON.stringify({ warn: "frontier_store_open_failed", message: String(e?.message || e) }));
  }
}

if (!ids.length) {
  console.error("APPLY_IDS required");
  process.exit(2);
}

function liveSnapshotHash(lead) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ id: lead.id, status: lead.status, notes: lead.notes, evidence: lead.evidence }))
    .digest("hex");
}

const rows = [];
for (const id of ids) {
  const p = path.join(RESULTS_DIR, `${id}.json`);
  if (!fs.existsSync(p)) {
    console.error(JSON.stringify({ error: "missing_result", id, path: p }));
    process.exit(2);
  }
  const r = JSON.parse(fs.readFileSync(p, "utf8"));
  const gate = validateCertifiedApplyRow({
    ...r,
    requirePersistedCompleteness: r.processingState === "HOT_VERIFIED",
  });
  if (!gate.ok) {
    console.error(
      JSON.stringify({
        error: gate.error,
        id,
        processingState: r.processingState,
        reasons: gate.reasons,
      })
    );
    process.exit(2);
  }
  rows.push(r);
}

console.log(
  JSON.stringify({
    mode: APPLY_LIVE ? "apply_live" : "dry-run",
    count: rows.length,
    ids: rows.map((r) => r.id),
    states: rows.map((r) => r.processingState),
  })
);

if (!APPLY_LIVE) {
  console.log(
    JSON.stringify({
      event: "dry_run_ok",
      plan: rows.map((r) => ({
        id: r.id,
        processingState: r.processingState,
        preserveCrm: { status: r.crmStatus, notes: r.notes },
        policyCompany: r.policyCompany,
        policyExpiry: r.policyExpiry,
      })),
    })
  );
  process.exit(0);
}

if (!BACKUP_META || !fs.existsSync(BACKUP_META)) {
  console.error("BACKUP_META_PATH required");
  process.exit(2);
}
const meta = JSON.parse(fs.readFileSync(BACKUP_META, "utf8"));
if (!meta?.restoreTest?.ok || meta.integrity !== "ok") {
  console.error("STOP-SHIP: backup restoreTest not ok");
  process.exit(2);
}
if (!LIVE_URL) {
  console.error("LIVE_DATABASE_URL required");
  process.exit(2);
}

const { PrismaClient } = await import("@prisma/client");
const live = new PrismaClient({ datasources: { db: { url: LIVE_URL } } });
const audit = [];

try {
  for (const r of rows) {
    const before = await live.lead.findUnique({ where: { id: r.id } });
    if (!before) throw new Error(`missing live ${r.id}`);
    const status = before.status;
    const notes = before.notes;
    const preHash = liveSnapshotHash(before);

    await live.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id: r.id },
        data: {
          evidence: r.fullEvidence,
          website: r.website ?? undefined,
          websiteReachable: r.websiteReachable ?? undefined,
          policyFound: r.policyFound ?? undefined,
          policyCompany: r.policyCompany ?? undefined,
          policyNumber: r.policyNumber ?? undefined,
          policyExpiry: r.policyExpiry ? new Date(r.policyExpiry) : undefined,
          policyMassimale: r.policyMassimale ?? undefined,
          phone: r.phone ?? undefined,
          email: r.email ?? undefined,
          pec: r.pec ?? undefined,
          piva: r.piva ?? undefined,
          leadScore: r.leadScore ?? undefined,
          pagesVisited: r.pagesVisited ?? undefined,
          lastScannedAt: r.lastScannedAt ? new Date(r.lastScannedAt) : new Date(),
          status,
          notes,
        },
      });
      const after = await tx.lead.findUnique({ where: { id: r.id } });
      if (!after) throw new Error(`missing after ${r.id}`);
      if (after.status !== status || after.notes !== notes) throw new Error(`CRM_MISMATCH ${r.id}`);
      if (after.evidence !== r.fullEvidence) throw new Error(`EVIDENCE_MISMATCH ${r.id}`);
    });

    audit.push({
      id: r.id,
      processingState: r.processingState,
      crmPreserved: true,
      evidenceApplied: true,
      preHash,
    });
    console.log(JSON.stringify({ event: "applied", id: r.id, processingState: r.processingState }));
  }
} catch (e) {
  console.error(JSON.stringify({ event: "apply_failed", error: String(e), audit }));
  await live.$disconnect().catch(() => {});
  process.exit(3);
}

await live.$disconnect().catch(() => {});
const outDir = path.dirname(RESULTS_DIR);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, `apply-audit-progressive-${Date.now()}.json`),
  JSON.stringify({ applied: audit.length, at: new Date().toISOString(), audit }, null, 2)
);
console.log(JSON.stringify({ event: "apply_done", applied: audit.length }));
process.exit(0);
