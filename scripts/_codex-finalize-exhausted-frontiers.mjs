import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const dbPath = resolve(process.argv[2] || "");
if (!process.argv[2]) {
  throw new Error("usage: _codex-finalize-exhausted-frontiers.mjs <frontier.sqlite>");
}

process.env.CRAWL_REQUIRE_EXHAUSTIVE_SITE = "1";

const auditDb = new DatabaseSync(dbPath);
const candidates = auditDb
  .prepare(
    `SELECT id, leadId, state, stopReason, identityVerified, scopeVerified,
            totalDiscovered, totalCompleted, totalPending, totalRetryPending, totalFailed
       FROM CrawlRun
      WHERE totalDiscovered > 0
        AND totalCompleted >= totalDiscovered
        AND totalPending = 0
        AND totalRetryPending = 0
        AND totalFailed = 0
        AND urlCapReached = 0
        AND timeCapReached = 0
        AND (
          state IN ('RUNNING', 'PAUSED')
          OR (state = 'FAILED' AND stopReason = 'frontier_exhausted')
        )`
  )
  .all();
auditDb.close();

const frontier = await import("../src/lib/sanita/frontier-store.ts");
frontier.openFrontierStore(dbPath);

const results = [];
try {
  for (const run of candidates) {
    const completeness = frontier.finalizeExhaustedCrawlRunAfterIdentity(run.id);
    const after = frontier.getCrawlRun(run.id);
    results.push({
      id: run.id,
      leadId: run.leadId,
      beforeState: run.state,
      identityVerified: Boolean(run.identityVerified),
      scopeVerified: Boolean(run.scopeVerified),
      afterState: after?.state ?? null,
      complete: completeness.complete,
      total: run.totalDiscovered,
    });
  }
} finally {
  frontier.closeFrontierStore();
}

console.log(JSON.stringify({ dbPath, repaired: results.length, results }, null, 2));
