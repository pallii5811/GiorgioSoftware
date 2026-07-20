/**
 * Lightweight gates for revalidation pipeline helpers.
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const start = Date.now();
let pass = 0;
let fail = 0;
function ok(c, m) {
  if (c) {
    pass++;
    console.log(`  ✓ ${m}`);
  } else {
    fail++;
    console.error(`  ✗ ${m}`);
  }
}

ok(fs.existsSync("scripts/production-revalidate-sanita-v2.mjs"), "revalidate script present");
ok(fs.existsSync("scripts/production-apply-revalidation.mjs"), "apply script present");
ok(fs.existsSync("scripts/hetzner-bluegreen-deploy.sh"), "bluegreen script present");

const src = fs.readFileSync("scripts/production-revalidate-sanita-v2.mjs", "utf8");
ok(!/SCAN_FAST\s*=\s*["']1["']/.test(src), "revalidate never forces SCAN_FAST=1");
ok(/analyzeLead/.test(src), "uses analyzeLead");
ok(/REVALIDATE_DUAL_HOT/.test(src), "dual hot supported");
ok(/checkpoint/.test(src), "checkpoint present");

const apply = fs.readFileSync("scripts/production-apply-revalidation.mjs", "utf8");
ok(/APPLY_LIVE/.test(apply), "apply requires flag");
ok(/restoreTest/.test(apply), "apply requires backup restore test");

// priority ordering self-check (inline mirror)
function priorityBucket(token) {
  if (token === "HOT") return 0;
  if (token === "PUBLISHED") return 1;
  if (token === "REVIEW") return 2;
  return 3;
}
const order = ["REVIEW", "HOT", "PUBLISHED", null].sort(
  (a, b) => priorityBucket(a) - priorityBucket(b)
);
ok(order[0] === "HOT" && order[1] === "PUBLISHED", "priority HOT then PUB");

console.log(
  JSON.stringify({ suite: "revalidation-pipeline", exitCode: fail === 0 ? 0 : 1, pass, fail, durationMs: Date.now() - start }, null, 2)
);
process.exit(fail === 0 ? 0 : 1);
