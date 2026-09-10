/**
 * Apply certified revalidation results to live — dry-run default.
 * Reads ONLY result JSON fullEvidence (never live after.evidence as source of truth).
 * APPLY_LIVE=1 requires BACKUP_META_PATH restoreTest.ok + LIVE_DATABASE_URL.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isTerminalState, resultHasRequiredFields } from "./revalidate-checkpoint-v3.mjs";

const ROOT = path.resolve(".");
const RESULTS_DIR =
  process.env.REVALIDATE_RESULTS_DIR || path.join(ROOT, "data/revalidation/results");
const CHECKPOINT =
  process.env.REVALIDATE_CHECKPOINT || path.join(ROOT, "data/revalidation/checkpoint.json");
const APPLY_LIVE = process.env.APPLY_LIVE === "1";
const BACKUP_META = process.env.BACKUP_META_PATH;
const EXPECTED_TOTAL = Number(process.env.REVALIDATE_EXPECTED || 877);
const LIVE_URL = process.env.LIVE_DATABASE_URL || (APPLY_LIVE ? process.env.DATABASE_URL : null);

if (!APPLY_LIVE) {
  console.log(JSON.stringify({ mode: "dry-run", hint: "Set APPLY_LIVE=1 after gates" }));
}

if (APPLY_LIVE) {
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
  if (!/\/opt\/leadsniper\/prisma\/dev\.db|file:.*dev\.db/i.test(LIVE_URL) && process.env.ALLOW_NONSTANDARD_LIVE !== "1") {
    // allow but warn
    console.log(JSON.stringify({ warn: "live_url_nonstandard" }));
  }
}

const cp = JSON.parse(fs.readFileSync(CHECKPOINT, "utf8"));
const terminal = cp.terminal || {};
const retryQueue = cp.retryQueue || {};
const inProgress = cp.inProgress || {};
const resultFiles = fs.existsSync(RESULTS_DIR)
  ? fs.readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".json") && !f.includes(".p1.") && !f.includes(".p2.") && !f.includes(".tmp."))
  : [];

const rows = resultFiles.map((f) => JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), "utf8")));

const terminalIds = Object.keys(terminal);
const gates = {
  version_v3: (cp.version || 0) >= 3,
  retry_queue_empty: Object.keys(retryQueue).length === 0,
  in_progress_empty: Object.keys(inProgress).length === 0,
  terminal_expected: terminalIds.length === EXPECTED_TOTAL,
  results_cover_terminal: terminalIds.every((id) => fs.existsSync(path.join(RESULTS_DIR, `${id}.json`))),
  all_results_have_full_evidence: rows
    .filter((r) => terminal[r.id])
    .every((r) => resultHasRequiredFields(r) && typeof r.fullEvidence === "string"),
  no_retry_as_terminal: terminalIds.every((id) => {
    const st = terminal[id]?.processingState;
    return st !== "RETRY_PENDING" && isTerminalState(st);
  }),
  no_dual_hot_as_hot: rows.every((r) => !(r.dualDisagreement && r.newVerdict === "HOT")),
  no_hot_without_verified: rows.every(
    (r) => !(r.newVerdict === "HOT" && r.processingState !== "HOT_VERIFIED" && terminal[r.id])
  ),
};

const failures = Object.entries(gates)
  .filter(([, v]) => !v)
  .map(([k]) => k);

console.log(
  JSON.stringify(
    {
      gates,
      failures,
      terminal: terminalIds.length,
      results: rows.length,
      retry: Object.keys(retryQueue).length,
      expected: EXPECTED_TOTAL,
    },
    null,
    2
  )
);

if (failures.length) {
  process.exit(1);
}

function liveSnapshotHash(lead) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        id: lead.id,
        status: lead.status,
        notes: lead.notes,
        evidence: lead.evidence,
      })
    )
    .digest("hex");
}

if (!APPLY_LIVE) {
  const plan = terminalIds.map((id) => {
    const r = rows.find((x) => x.id === id);
    return {
      id,
      processingState: r?.processingState || terminal[id].processingState,
      hasFullEvidence: typeof r?.fullEvidence === "string",
      preserveCrm: { status: r?.crmStatus, notes: r?.notes },
      inputSnapshotHash: r?.inputSnapshotHash,
    };
  });
  fs.mkdirSync(path.join(ROOT, "data/revalidation"), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, "data/revalidation/apply-plan.json"),
    JSON.stringify({ dryRun: true, planCount: plan.length, sample: plan.slice(0, 20) }, null, 2)
  );
  console.log(JSON.stringify({ event: "dry_run_ok", planCount: plan.length }));
  process.exit(0);
}

const { PrismaClient } = await import("@prisma/client");
const live = new PrismaClient({ datasources: { db: { url: LIVE_URL } } });
const CHUNK = Number(process.env.APPLY_CHUNK || 50);
let applied = 0;
const audit = [];

try {
  for (let i = 0; i < terminalIds.length; i += CHUNK) {
    const chunkIds = terminalIds.slice(i, i + CHUNK);
    const pre = [];
    for (const id of chunkIds) {
      const liveLead = await live.lead.findUnique({ where: { id } });
      if (!liveLead) throw new Error(`missing live ${id}`);
      const r = rows.find((x) => x.id === id);
      if (!r || typeof r.fullEvidence !== "string") throw new Error(`missing fullEvidence ${id}`);
      // stale snapshot: CRM-critical fields changed unexpectedly vs recorded crm — allow CRM drift but block if inputSnapshot was for evidence-only; we compare status/notes preservation intent
      pre.push({
        id,
        status: liveLead.status,
        notes: liveLead.notes,
        hash: liveSnapshotHash(liveLead),
        row: r,
      });
    }

    for (const item of pre) {
      const { row: r, status, notes } = item;
      await live.lead.update({
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
    }

    // verify chunk
    for (const item of pre) {
      const after = await live.lead.findUnique({ where: { id: item.id } });
      if (!after) throw new Error(`missing after ${item.id}`);
      if (after.status !== item.status || after.notes !== item.notes) {
        throw new Error(`CRM_MISMATCH ${item.id}`);
      }
      if (after.evidence !== item.row.fullEvidence) {
        throw new Error(`EVIDENCE_MISMATCH ${item.id}`);
      }
      audit.push({
        id: item.id,
        processingState: item.row.processingState,
        crmPreserved: true,
        evidenceApplied: true,
      });
      applied++;
    }
    console.log(JSON.stringify({ event: "chunk_applied", from: i, to: i + chunkIds.length, applied }));
  }
} catch (e) {
  console.error(JSON.stringify({ event: "apply_failed", error: String(e), applied }));
  await live.$disconnect().catch(() => {});
  process.exit(3);
}

fs.writeFileSync(
  path.join(ROOT, "data/revalidation/apply-audit.json"),
  JSON.stringify({ applied, at: new Date().toISOString(), audit }, null, 2)
);
await live.$disconnect().catch(() => {});
console.log(JSON.stringify({ event: "apply_done", applied }));
process.exit(0);
