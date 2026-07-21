/**
 * Unit checks — job watchdog helpers.
 * Run: npx tsx scripts/test-sanita-job-watchdog.mjs
 */
import assert from "node:assert/strict";
import {
  runWithJobLeadTimeout,
  SANITA_JOB_LEAD_MAX_MS,
  SANITA_JOB_STALE_MS,
} from "../src/lib/sanita/job-watchdog.ts";

let failed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`PASS ${name}`))
    .catch((e) => {
      failed++;
      console.error(`FAIL ${name}:`, e.message);
    });
}

await check("runWithJobLeadTimeout_resolves_fast", async () => {
  const out = await runWithJobLeadTimeout(async () => "ok", 2000);
  assert.equal(out, "ok");
});

await check("runWithJobLeadTimeout_rejects_slow", async () => {
  let err = null;
  try {
    await runWithJobLeadTimeout(() => new Promise((r) => setTimeout(r, 80)), 30);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Error);
  assert.match(err.message, /Verifica non completata entro/);
});

await check("defaults_sane", () => {
  assert.ok(SANITA_JOB_LEAD_MAX_MS >= 60_000);
  assert.ok(SANITA_JOB_STALE_MS >= 30_000);
});

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll job-watchdog tests PASS");
