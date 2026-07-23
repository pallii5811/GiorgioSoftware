/**
 * Unit checks: relevance tiers + fair queue ratio + null nextRetryAt invariant helpers.
 */
import assert from "node:assert/strict";
import { classifyUrlRelevance } from "../src/lib/sanita/crawl-relevance.ts";
import {
  MAX_RETRY_ATTEMPTS,
  nextRetryAt,
  classifyResult,
  pickRetryStrategy,
} from "./revalidate-checkpoint-v3.mjs";

let fail = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error("FAIL", msg);
    fail++;
  } else {
    console.log("PASS", msg);
  }
}

ok(classifyUrlRelevance("https://x.it/assicurazione-rct") === "critical", "critical assicurazione");
ok(classifyUrlRelevance("https://x.it/polizza.pdf") === "critical", "critical pdf");
ok(classifyUrlRelevance("https://x.it/", { discoverySource: "seed" }) === "relevant", "seed home relevant");
ok(classifyUrlRelevance("https://x.it/chi-siamo", { discoverySource: "seed_guess" }) === "relevant", "seed chi-siamo");
ok(classifyUrlRelevance("https://x.it/news/foo", { discoverySource: "html-link" }) === "low", "news low");
ok(classifyUrlRelevance("https://x.it/servizi/cardiologia", { discoverySource: "html-link" }) === "low", "servizi low");
ok(classifyUrlRelevance("https://x.it/random-page", { discoverySource: "html-link" }) === "low", "html-link default low");
ok(classifyUrlRelevance("https://x.it/brochure.pdf", { discoverySource: "html-link" }) === "low", "non-policy pdf low");

ok(MAX_RETRY_ATTEMPTS === 5 || Number(process.env.REVALIDATE_MAX_RETRY) > 0, "max retry default 5");
ok(classifyResult({ processingState: "TECHNICAL_BLOCKED" }).kind === "terminal", "tech = checkpoint terminal");
ok(pickRetryStrategy(3, "CRAWL_CAP", "resume_boost") !== "fresh", "no fresh on CAP");
ok(pickRetryStrategy(2, "PDF_UNPROCESSED", "resume") === "resume_boost", "boost on attempt 2");

const a1 = Date.parse(nextRetryAt(1, { sliceContinue: true }));
const now = Date.now();
ok(a1 - now >= 25_000, "sliceContinue backoff >=30s-ish");

// Fair queue helper (inline mirror of parent)
function buildFairQueue(due, news) {
  const queue = [];
  let i = 0;
  let j = 0;
  while (i < due.length || j < news.length) {
    for (let k = 0; k < 4 && j < news.length; k++) queue.push(news[j++]);
    if (i < due.length) queue.push(due[i++]);
    if (j >= news.length) {
      while (i < due.length) queue.push(due[i++]);
      break;
    }
  }
  return queue;
}
const q = buildFairQueue(["r1", "r2"], ["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"]);
ok(q[0] === "n1" && q[4] === "r1", "fair 4 news then 1 retry");
ok(q.filter((x) => String(x).startsWith("r")).length === 2, "both retries scheduled after news blocks");

process.exit(fail ? 1 : 0);
