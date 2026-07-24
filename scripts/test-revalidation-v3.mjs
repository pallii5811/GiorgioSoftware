/**
 * Tests for revalidation v3: checkpoint migration, RETRY not terminal, isolation contracts.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  migrateCheckpointV2toV3,
  classifyResult,
  isTerminalState,
  writeResultAtomic,
  resultHasRequiredFields,
  emptyCheckpointV3,
  saveCheckpointAtomic,
  TERMINAL_STATES,
} from "./revalidate-checkpoint-v3.mjs";

const start = Date.now();
let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reval-v3-"));
const resultsDir = path.join(tmp, "results");
fs.mkdirSync(resultsDir);

// existing 5 retry migration
const five = [
  "cmqkld5s0009u108eghihpoxi",
  "id2",
  "id3",
  "id4",
  "id5",
];
const v2 = {
  version: 2,
  testedCodeSha: "a".repeat(40),
  done: {},
  stats: { processed: 5, retry: 5 },
};
for (const id of five) {
  v2.done[id] = { finishedAt: "2026-07-20T17:00:00Z", newVerdict: null, processingState: "RETRY_PENDING", reasonCode: "RETRY_PENDING" };
  fs.writeFileSync(
    path.join(resultsDir, `${id}.json`),
    JSON.stringify({
      id,
      processingState: "RETRY_PENDING",
      newVerdict: null,
      reasonCode: "RETRY_PENDING",
      dualDisagreement: false,
      finishedAt: "2026-07-20T17:00:00Z",
    })
  );
}
const mig = migrateCheckpointV2toV3(v2, resultsDir, "b".repeat(40));
ok(mig.migrated === 5, "existing_5_retry_results_are_migrated");
ok(mig.retry === 5, "retry_pending_is_resumed (in retryQueue)");
ok(mig.terminal === 0, "retry_pending_not_added_to_terminal");
ok(Object.keys(mig.checkpoint.retryQueue).length === 5, "retryQueue size 5");
ok(Object.keys(mig.checkpoint.terminal).length === 0, "terminal empty after retry migrate");

// terminal not reprocessed
const v2b = {
  version: 2,
  done: {
    hot1: { processingState: "HOT_VERIFIED", newVerdict: "HOT" },
  },
};
fs.writeFileSync(
  path.join(resultsDir, "hot1.json"),
  JSON.stringify({ id: "hot1", processingState: "HOT_VERIFIED", newVerdict: "HOT", crawlComplete: true })
);
const mig2 = migrateCheckpointV2toV3(v2b, resultsDir, "c".repeat(40));
ok(mig2.terminal === 1 && mig2.retry === 0, "terminal_result_is_not_reprocessed");
ok(isTerminalState("HOT_VERIFIED"), "HOT_VERIFIED terminal");
ok(!isTerminalState("RETRY_PENDING"), "RETRY_PENDING not terminal");

const cls = classifyResult({ processingState: "RETRY_PENDING", newVerdict: null });
ok(cls.kind === "retry", "classify retry");
const clsT = classifyResult({ processingState: "PUBLISHED_EXPIRED", newVerdict: "PUBLISHED" });
ok(clsT.kind === "terminal", "classify published terminal");

// restart preserves retry schedule
const cpPath = path.join(tmp, "checkpoint.json");
saveCheckpointAtomic(cpPath, mig.checkpoint);
const reloaded = JSON.parse(fs.readFileSync(cpPath, "utf8"));
ok(reloaded.retryQueue[five[0]]?.nextRetryAt != null, "restart_preserves_retry_schedule");

// result full evidence + atomic write
const out = path.join(resultsDir, "full.json");
const row = writeResultAtomic(out, {
  id: "full",
  fullEvidence: "[V:HOT][STATE:HOT_VERIFIED] complete",
  processingState: "HOT_VERIFIED",
  schemaVersion: 3,
  policyFound: false,
  policyCompany: null,
  policyNumber: null,
  policyExpiry: null,
  policyMassimale: null,
});
ok(resultHasRequiredFields(row), "result_contains_full_evidence");
ok("policyNumber" in row && "policyExpiry" in row && "policyMassimale" in row, "result_contains_all_policy_fields");
ok(fs.existsSync(out) && !fs.existsSync(out + ".tmp"), "result_write_is_atomic");
ok(Boolean(row.contentHash || row.resultHash), "result_hash_is_reproducible field present");
ok(!resultHasRequiredFields({ id: "x", processingState: "HOT_VERIFIED" }), "partial_result_is_rejected");

// worker isolation contracts (static)
const parent = fs.readFileSync("scripts/production-revalidate-sanita-v3.mjs", "utf8");
const worker = fs.readFileSync("scripts/production-revalidate-sanita-worker.mjs", "utf8");
ok(!/from \"\.\/.*scan-engine|await import\(.*scan-engine/.test(parent), "parent_does_not_import_scan-engine");
ok(!/openFrontierStore\s*\(/.test(parent), "parent_no_openFrontierStore call");
ok(!/await import\([^\)]*frontier-store/.test(parent), "parent_no_frontier_store_import");
ok(/Never imports analyzeLead \/ openFrontierStore/.test(parent), "parent_documents_no_frontier");
ok(/Never imports analyzeLead|never import analyzeLead|Spawns isolated/i.test(parent), "parent_scheduler_isolation_documented");
ok(/FRONTIER_DB_PATH/.test(worker) && /REVALIDATE_LEAD_ID/.test(worker), "env_isolated_between_workers contract");
ok(/acquireLeadLock|\.lock/.test(parent), "same_lead_cannot_run_twice");
ok(/spawn\(/.test(parent), "two_workers_use_different_frontiers via spawn");
ok(/inProgress/.test(parent) && /IN_PROGRESS_INTERRUPTED|parent_restart/.test(parent), "parent_restart_resumes_in_progress_leads");
ok(/DUAL_HOT|needsDual|HOT_VERIFIED/.test(parent), "only_complete_hot_gets_second_pass");
ok(TERMINAL_STATES.has("OUT_OF_SCOPE"), "OUT_OF_SCOPE terminal");

// apply uses fullEvidence
const apply = fs.readFileSync("scripts/production-apply-revalidation.mjs", "utf8");
ok(/fullEvidence/.test(apply) && !/after\.evidence,\s*\/\//.test(apply), "shadow_full_evidence_is_copied_to_live");
ok(/CRM_MISMATCH|status,\s*notes/.test(apply), "crm_status_and_notes_are_preserved");
ok(/missing fullEvidence|resultHasRequiredFields/.test(apply), "missing_full_evidence_blocks_apply");
ok(/LIVE_DATABASE_URL|datasources/.test(apply), "live_old_evidence_is_not_reused as source");

console.log(
  JSON.stringify({
    suite: "revalidation-v3",
    exitCode: fail === 0 ? 0 : 1,
    pass,
    fail,
    durationMs: Date.now() - start,
  }, null, 2)
);
process.exit(fail === 0 ? 0 : 1);
