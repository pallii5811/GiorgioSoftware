/**
 * Waterfall integration — all applicable steps attempted and traced (no network required).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  openFrontierStore,
  closeFrontierStore,
  createCrawlRun,
  listWaterfallSteps,
} from "../src/lib/sanita/frontier-store.ts";
import {
  runProductionWaterfall,
  PRODUCTION_WATERFALL_TRACE,
  productionWaterfallStepCount,
} from "../src/lib/sanita/production-waterfall.ts";

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

ok(productionWaterfallStepCount() === 20, `20 production steps (got ${productionWaterfallStepCount()})`);
ok(PRODUCTION_WATERFALL_TRACE.length === 20, "trace length 20");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-"));
const dbPath = path.join(dir, "wf.sqlite");
openFrontierStore(dbPath);
const { crawlRunId } = createCrawlRun({ leadId: "L", runId: "WF1", workerId: "t" });

const seen = [];
const outcome = await runProductionWaterfall({
  website: "https://example.invalid",
  crawlRunId,
  probeImpl: async (step) => {
    seen.push(step);
    return { success: true, evidenceAdded: [`mock:${step}`] };
  },
});

ok(outcome.terminalVerdictEmitted === false, "waterfall never emits terminal verdict");
ok(outcome.traversed.length === 20, `traversed 20 (got ${outcome.traversed.length})`);
ok(seen.length === 20, `probe invoked 20 times (got ${seen.length})`);
const persisted = listWaterfallSteps(crawlRunId);
ok(persisted.length === 20, `persisted 20 step records (got ${persisted.length})`);
ok(new Set(seen).size === 20, "all step ids unique in run");

closeFrontierStore();
fs.rmSync(dir, { recursive: true, force: true });

console.log(
  JSON.stringify({
    suite: "waterfall-integration",
    exitCode: fail === 0 ? 0 : 1,
    durationMs: Date.now() - start,
    pass,
    fail,
    skipped: 0,
  }, null, 2)
);
process.exit(fail === 0 ? 0 : 1);
