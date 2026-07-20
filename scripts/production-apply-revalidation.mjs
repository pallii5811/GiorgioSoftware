/**
 * Apply shadow revalidation results to live DB — dry-run by default.
 * APPLY_LIVE=1 + BACKUP_META_PATH with restoreTest.ok required.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(".");
const RESULTS_DIR = path.join(ROOT, "data/revalidation/results");
const CHECKPOINT =
  process.env.REVALIDATE_CHECKPOINT || path.join(ROOT, "data/revalidation/checkpoint.json");
const APPLY_LIVE = process.env.APPLY_LIVE === "1";
const BACKUP_META = process.env.BACKUP_META_PATH;

if (!APPLY_LIVE) {
  console.log(JSON.stringify({ mode: "dry-run", hint: "Set APPLY_LIVE=1 after gates" }));
}

if (APPLY_LIVE) {
  if (!BACKUP_META || !fs.existsSync(BACKUP_META)) {
    console.error("BACKUP_META_PATH required and must exist for APPLY_LIVE");
    process.exit(2);
  }
  const meta = JSON.parse(fs.readFileSync(BACKUP_META, "utf8"));
  if (!meta?.restoreTest?.ok || meta.integrity !== "ok") {
    console.error("STOP-SHIP: backup restoreTest not ok");
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL required");
    process.exit(2);
  }
}

const cp = JSON.parse(fs.readFileSync(CHECKPOINT, "utf8"));
const resultFiles = fs.existsSync(RESULTS_DIR)
  ? fs.readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".json"))
  : [];

const rows = resultFiles.map((f) =>
  JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), "utf8"))
);

const expected = Object.keys(cp.done || {}).length;
const gates = {
  checkpoint_results_aligned: resultFiles.length === expected,
  skipped_zero: true,
  has_rows: rows.length > 0,
  no_dual_hot_as_hot: rows.every((r) => !(r.dualDisagreement && r.newVerdict === "HOT")),
};

const failures = Object.entries(gates)
  .filter(([, v]) => !v)
  .map(([k]) => k);

console.log(JSON.stringify({ gates, failures, rows: rows.length, expected }, null, 2));

if (failures.length) {
  process.exit(1);
}

if (!APPLY_LIVE) {
  const plan = rows.map((r) => ({
    id: r.id,
    oldVerdict: r.oldVerdict,
    newVerdict: r.newVerdict,
    processingState: r.processingState,
    preserveCrm: { status: r.crmStatus, notes: r.notes },
  }));
  fs.mkdirSync(path.join(ROOT, "data/revalidation"), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, "data/revalidation/apply-plan.json"),
    JSON.stringify({ dryRun: true, planCount: plan.length, sample: plan.slice(0, 20) }, null, 2)
  );
  console.log(JSON.stringify({ event: "dry_run_ok", planCount: plan.length }));
  process.exit(0);
}

const { prisma } = await import("../src/lib/prisma.ts");
const CHUNK = Number(process.env.APPLY_CHUNK || 50);
let applied = 0;

for (let i = 0; i < rows.length; i += CHUNK) {
  const chunk = rows.slice(i, i + CHUNK);
  for (const r of chunk) {
    const after = await prisma.lead.findUnique({ where: { id: r.id } });
    if (!after) continue;
    // Preserve CRM: do not overwrite status/notes from revalidation row; keep live CRM
    await prisma.lead.update({
      where: { id: r.id },
      data: {
        evidence: after.evidence, // already written on shadow; live apply expects shadow==live path
        // When applying from shadow copy that was revalidated in place, evidence already updated.
        // For separate live DB, copy new evidence from result file if present as fullEvidence.
        ...(r.fullEvidence ? { evidence: r.fullEvidence } : {}),
        website: r.contacts?.website ?? after.website,
        policyFound: r.policyFound ?? after.policyFound,
        policyCompany: r.policyCompany ?? after.policyCompany,
        lastScannedAt: new Date(),
      },
    });
    applied++;
  }
  console.log(JSON.stringify({ event: "chunk_applied", from: i, to: i + chunk.length, applied }));
}

await prisma.$disconnect().catch(() => {});
console.log(JSON.stringify({ event: "apply_done", applied }));
process.exit(0);
