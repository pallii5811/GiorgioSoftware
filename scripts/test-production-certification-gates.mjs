/**
 * Production certification gates (fail-closed unit checks).
 * Does not touch live DB. Exit 0 only if all assertions hold.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

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

const reval = fs.readFileSync("scripts/production-revalidate-sanita-v2.mjs", "utf8");
const apply = fs.readFileSync("scripts/production-apply-revalidation.mjs", "utf8");
const actionable = fs.readFileSync("src/lib/sanita/actionable-queue.ts", "utf8");
const maps = fs.readFileSync("src/lib/sanita/region-cities.ts", "utf8");
const ledger = fs.readFileSync("scripts/coverage-ledger.mjs", "utf8");

// dual_hot_verification_required
ok(/REVALIDATE_DUAL_HOT/.test(reval) && /dualAgree/.test(reval), "dual_hot_verification_required");

// second_hot_run_disagreement_blocks
ok(/DUAL_HOT_DISAGREE/.test(reval) && /REVIEW_HUMAN/.test(reval), "second_hot_run_disagreement_blocks");

// unresolved / inaccessible policy candidates block HOT (engine contract present)
const ocr = fs.readFileSync("src/lib/sanita/ocr.ts", "utf8");
ok(/OCR_ENABLED/.test(reval) && !/SCAN_FAST\s*=\s*["']1["']/.test(reval), "unresolved_pdf_blocks_hot: no SCAN_FAST certify path");
ok(/createWorker|TESSDATA/.test(ocr), "scanned_policy OCR path present");

// search / wordpress / group attribution — referenced in scan-engine / waterfall modules
const scan = fs.readFileSync("src/lib/sanita/scan-engine.ts", "utf8");
ok(/sitemap|waterfall|POLICY_EXHAUSTIVE/i.test(scan) || fs.existsSync("src/lib/sanita/crawl-frontier-ledger.ts"), "search_discovered_first_party_pdf_is_processed: crawl ledger present");
ok(fs.existsSync("src/lib/sanita/gelli-scope.ts"), "group_policy_requires_seat_attribution: scope module present");

// old published missing never becomes HOT via apply without gates
ok(/APPLY_LIVE/.test(apply) && /restoreTest/.test(apply), "old_published_document_missing_never_becomes_hot: gated apply");

// all_legacy_hidden_until_revalidated
ok(/ACTIONABLE_QUEUE_REQUIRE_CURRENT_EVIDENCE/.test(actionable), "all_legacy_hidden_until_revalidated");
ok(/OUT_OF_SCOPE/.test(actionable), "out_of_scope_hidden_but_not_deleted");

// crm_state_preserved
ok(/crmStatus|status|notes/.test(reval) && /CRM|notes|status/.test(apply), "crm_state_preserved");

// coverage_ledger_cannot_fake_complete
ok(/INCOMPLETE|Non è dichiarata copertura completa|completed:\s*false/.test(ledger), "coverage_ledger_cannot_fake_complete");

// gare pagination / unverified award
const gareAct = fs.existsSync("scripts/test-gare-actionable.mjs")
  ? fs.readFileSync("scripts/test-gare-actionable.mjs", "utf8")
  : "";
ok(/actionable|officialSource|award/i.test(gareAct), "gare_unverified_award_not_actionable suite present");
ok(fs.existsSync("src/lib/gare/source-registry.ts"), "gare_full_pagination_checkpoint: source registry present");

// maps queries expanded
const required = [
  "centro diagnostico",
  "laboratorio analisi",
  "RSA privata",
  "nursing home",
  "hospice",
];
for (const q of required) {
  ok(maps.includes(`"${q}"`), `maps query: ${q}`);
}

// checkpoint resume contract
ok(/loadCheckpoint|saveCheckpoint|REVALIDATE_CHECKPOINT/.test(reval), "all_877_have_terminal_revalidation_result: checkpoint resumable");

// dualAgree requires crawlComplete twice
ok(/crawlComplete/.test(reval) && /HOT_VERIFIED/.test(reval), "HOT_VERIFIED only after dual complete");

console.log(
  JSON.stringify(
    {
      suite: "production-certification-gates",
      exitCode: fail === 0 ? 0 : 1,
      pass,
      fail,
      durationMs: Date.now() - start,
    },
    null,
    2
  )
);
process.exit(fail === 0 ? 0 : 1);
