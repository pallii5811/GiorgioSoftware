/**
 * Unit tests — job controller helpers (no Playwright).
 * Run: npx tsx scripts/test-sanita-jobs-unit.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  buildTargetKey,
  emptySanitaJob,
  isActiveSanitaJob,
  writeSanitaJob,
  readSanitaJob,
  findActiveJobByTarget,
} from "../src/lib/sanita/jobs.ts";

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}:`, e.message);
  }
}

const prevCwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sanita-jobs-test-"));
process.chdir(tmp);
fs.mkdirSync("data/sanita-jobs", { recursive: true });

try {
  check("buildTargetKey_single", () => {
    assert.equal(buildTargetKey({ mode: "single", region: "Veneto", leadId: "abc" }), "single:abc");
    assert.equal(
      buildTargetKey({ mode: "city", region: "Campania", city: "Napoli" }),
      "city:Campania:napoli"
    );
    assert.equal(buildTargetKey({ mode: "region", region: "Veneto" }), "region:Veneto");
  });

  check("cancelRequested_not_active", () => {
    const j = emptySanitaJob({
      jobId: "j1",
      mode: "region",
      region: "Veneto",
    });
    j.cancelRequested = true;
    assert.equal(isActiveSanitaJob(j), false);
  });

  check("dedup_finds_running_job", () => {
    const j = emptySanitaJob({ jobId: "j2", mode: "region", region: "Campania" });
    j.status = "running";
    writeSanitaJob(j);
    const found = findActiveJobByTarget(j.targetKey);
    assert.equal(found?.jobId, "j2");
  });

  check("write_then_read_roundtrip", () => {
    const j = emptySanitaJob({ jobId: "j3", mode: "single", region: "Veneto", leadId: "x" });
    writeSanitaJob(j);
    const r = readSanitaJob("j3");
    assert.equal(r?.status, "queued");
    assert.equal(r?.lastUpdateLabel, "In attesa");
  });
} finally {
  process.chdir(prevCwd);
}

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll sanita-jobs unit tests PASS");
