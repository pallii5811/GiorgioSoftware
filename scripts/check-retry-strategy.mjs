#!/usr/bin/env node
/**
 * Self-check: nessun retry deve azzerare il frontier (loop infinito con 1 worker).
 * Run: npx tsx scripts/check-retry-strategy.mjs
 */
import assert from "node:assert/strict";
import { pickRetryStrategy } from "./revalidate-checkpoint-v3.mjs";

for (const err of [
  "IDENTITY_MISMATCH",
  "REQUEUE_INCOMPLETE_REVIEW:IDENTITY_MISMATCH",
  "CRAWL_CAP",
  "ANALYZE_ERROR_OR_TIMEOUT",
  "PDF_UNPROCESSED",
  "IN_PROGRESS_INTERRUPTED",
]) {
  for (const attempts of [0, 1, 2, 3, 5]) {
    const s = pickRetryStrategy(attempts, err, null);
    assert.notEqual(
      s,
      "fresh",
      `strategy 'fresh' butta il crawl: err=${err} attempts=${attempts}`
    );
    assert.ok(
      s === "resume" || s === "resume_boost",
      `strategy inattesa ${s} per ${err}/${attempts}`
    );
  }
}

// Il boost deve arrivare con i tentativi ripetuti, non subito.
assert.equal(pickRetryStrategy(0, "IDENTITY_MISMATCH", null), "resume");
assert.equal(pickRetryStrategy(3, "IDENTITY_MISMATCH", null), "resume_boost");

console.log("OK retry-strategy self-check");
