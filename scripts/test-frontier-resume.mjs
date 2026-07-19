/**
 * Resume-focused frontier test (SIGINT/crash simulation).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  openFrontierStore,
  closeFrontierStore,
  createCrawlRun,
  upsertFrontierNode,
  transitionFrontierNode,
  listNodes,
  releaseWorkerLock,
} from "../src/lib/sanita/frontier-store.ts";

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-resume-"));
const dbPath = path.join(dir, "f.sqlite");
openFrontierStore(dbPath);
const { crawlRunId } = createCrawlRun({ leadId: "L", runId: "R1", workerId: "A" });
const { id } = upsertFrontierNode({
  crawlRunId,
  canonicalUrl: "https://a.it/page",
  resourceType: "html",
  relevance: "relevant",
});
transitionFrontierNode(id, "QUEUED");
transitionFrontierNode(id, "FETCHING");
// simulate crash: close without complete
closeFrontierStore();

openFrontierStore(dbPath);
let locked = false;
try {
  createCrawlRun({ leadId: "L", runId: "R1", workerId: "B" });
} catch {
  locked = true;
}
ok(locked, "second worker blocked while lock held");

// crash recovery: open and release stale lock then resume
releaseWorkerLock(crawlRunId);
const { resumed } = createCrawlRun({ leadId: "L", runId: "R1", workerId: "B" });
ok(resumed, "worker B resumes after lock release");
const n = listNodes(crawlRunId);
ok(n.length === 1, "no node loss");
ok(n[0].state === "FETCHING", "state preserved at crash point");
transitionFrontierNode(n[0].id, "FETCHED");
transitionFrontierNode(n[0].id, "PARSED");
transitionFrontierNode(n[0].id, "COMPLETED");
ok(listNodes(crawlRunId)[0].state === "COMPLETED", "resume completes node");
const { created } = upsertFrontierNode({
  crawlRunId,
  canonicalUrl: "https://a.it/page",
  resourceType: "html",
  relevance: "relevant",
});
ok(!created, "no duplicate after resume");
closeFrontierStore();
fs.rmSync(dir, { recursive: true, force: true });

console.log(
  JSON.stringify({
    suite: "frontier-resume",
    exitCode: fail === 0 ? 0 : 1,
    durationMs: Date.now() - start,
    pass,
    fail,
    skipped: 0,
  }, null, 2)
);
process.exit(fail === 0 ? 0 : 1);
