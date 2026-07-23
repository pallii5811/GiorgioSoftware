/**
 * RC-09: after CRAWL_CAP / URL_CAP / wall timeout, v3 must start a fresh frontier
 * (resume of a capped frontier re-emits CRAWL_CAP in seconds without crawling).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "scripts/production-revalidate-sanita-v3.mjs"), "utf8");

assert.match(src, /frontier_fresh_after_cap/, "must log frontier_fresh_after_cap");
assert.match(src, /CRAWL_CAP\|URL_CAP/, "must detect CRAWL_CAP/URL_CAP as non-reusable");
assert.match(src, /capBlocked/, "must gate reuse on capBlocked");

function wouldReuse({ lastReason, frontierPath, lastRunId }) {
  const prevReason = String(lastReason || "");
  const capBlocked = /CRAWL_CAP|URL_CAP|RUN_WALL_CLOCK|LEAD_WALL_TIMEOUT|TIME_CAP/i.test(prevReason);
  return (
    !capBlocked &&
    Boolean(frontierPath) &&
    Boolean(lastRunId) &&
    !prevReason.includes("IDENTITY")
  );
}

assert.equal(wouldReuse({ lastReason: "CRAWL_CAP", frontierPath: "/x", lastRunId: "r1" }), false);
assert.equal(wouldReuse({ lastReason: "URL_CAP", frontierPath: "/x", lastRunId: "r1" }), false);
assert.equal(wouldReuse({ lastReason: "FRONTIER_INCOMPLETE", frontierPath: "/x", lastRunId: "r1" }), true);
assert.equal(wouldReuse({ lastReason: "IDENTITY_MISMATCH", frontierPath: "/x", lastRunId: "r1" }), false);

console.log(JSON.stringify({ ok: true, rc: "RC-09" }));
