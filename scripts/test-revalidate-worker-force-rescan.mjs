/**
 * Regression RC-07: isolated revalidate worker must set FORCE_RESCAN_PUB
 * so analyzeLead does not early-return on legacy PUB+policyFound leads.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = path.join(root, "scripts/production-revalidate-sanita-worker.mjs");
const src = fs.readFileSync(workerPath, "utf8");

assert.match(
  src,
  /FORCE_RESCAN_PUB\s*=\s*process\.env\.FORCE_RESCAN_PUB\s*\|\|\s*["']1["']/,
  "worker must default FORCE_RESCAN_PUB=1"
);
assert.match(src, /RC-07/, "RC-07 comment must remain (documents root cause)");

// Mirror scan-engine gate: without FORCE_RESCAN_PUB, PUB+policyFound skips crawl.
function wouldSkipCrawl({ forceRescanPub, token, policyFound }) {
  return !forceRescanPub && token === "PUBLISHED" && policyFound === true;
}
assert.equal(wouldSkipCrawl({ forceRescanPub: false, token: "PUBLISHED", policyFound: true }), true);
assert.equal(wouldSkipCrawl({ forceRescanPub: true, token: "PUBLISHED", policyFound: true }), false);

console.log(JSON.stringify({ ok: true, rc: "RC-07" }));
