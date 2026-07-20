#!/usr/bin/env node
/** Single-lead shadow fullcrawl — for hard OS-level timeout wrappers. */
process.env.POLICY_EXHAUSTIVE = process.env.POLICY_EXHAUSTIVE || "1";
process.env.OCR_ENABLED = process.env.OCR_ENABLED || "1";
process.env.SCAN_FAST = "0";
process.env.SCAN_ENGINE_LOCAL = "1";

import fs from "node:fs";
import path from "node:path";
import { requireShadowIsolation } from "../src/lib/shadow/guard.ts";
import { prisma } from "../src/lib/sanita/db-ready.ts";
import { analyzeLead } from "../src/lib/sanita/scan-engine.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";
import { terminateOcrWorker } from "../src/lib/sanita/ocr.ts";
import { closeMapsBrowserPool } from "../src/lib/sanita/playwright-maps.ts";
import { isLegacyLead } from "../src/lib/sanita/evidence-version.ts";

requireShadowIsolation();

const id = process.argv[2];
const region = process.argv[3] || "?";
if (!id) {
  console.error("usage: shadow-batch1-fullcrawl-one.mjs <id> <region>");
  process.exit(2);
}

const RESULTS = path.join(process.cwd(), "data/shadow/crawl/fullcrawl-results.jsonl");
fs.mkdirSync(path.dirname(RESULTS), { recursive: true });

function histVerdict(ev) {
  const m = /\[SHADOW_HIST_VERDICT:([A-Z]+)\]/i.exec(ev || "");
  if (m) {
    const x = m[1].toUpperCase();
    if (x === "PUB") return "PUBLISHED";
    if (x === "REV") return "REVIEW";
    return x;
  }
  return readVerdictToken(ev) || "UNKNOWN";
}

const before = await prisma.lead.findUnique({ where: { id } });
if (!before) {
  console.error("NOT_FOUND", id);
  process.exit(3);
}
const oldVerdict = histVerdict(before.evidence);
const t0 = Date.now();
const counters = { analyzed: 0, withPolicy: 0, hot: 0, review: 0 };
let err = null;
try {
  await analyzeLead(before, counters);
} catch (e) {
  err = String(e?.message || e).slice(0, 200);
}
const after = await prisma.lead.findUnique({ where: { id } });
const ev = after?.evidence || "";
const identityStatus = /\[IDENTITY:([A-Z_]+)\]/i.exec(ev)?.[1] || "NOT_CHECKED";
const crawlComplete = /\[CRAWL_COMPLETE:true\]/i.test(ev);
const newVerdict = readVerdictToken(ev) || "REVIEW";

const row = {
  id,
  region,
  companyName: after?.companyName || before.companyName,
  city: after?.city,
  website: after?.website,
  oldVerdict,
  preliminaryVerdict: "REVIEW",
  newVerdict,
  identityStatus,
  crawlComplete,
  pagesVisited: after?.pagesVisited ?? 0,
  policyFound: Boolean(after?.policyFound),
  policyCompany: after?.policyCompany,
  policyNumber: after?.policyNumber,
  policyExpiry: after?.policyExpiry,
  technicalFailure: Boolean(err) || /Timeout|403|429|WAF|DNS|SSL/i.test(ev),
  error: err,
  stillLegacy: isLegacyLead(ev),
  durationMs: Date.now() - t0,
  evidenceHead: ev.slice(0, 280),
};
fs.appendFileSync(RESULTS, JSON.stringify(row) + "\n");
console.log(JSON.stringify({ id, newVerdict, identityStatus, crawlComplete, durationMs: row.durationMs, error: err }));

await Promise.race([
  Promise.all([
    terminateOcrWorker().catch(() => {}),
    closeMapsBrowserPool().catch(() => {}),
    prisma.$disconnect(),
  ]),
  new Promise((r) => setTimeout(r, 15_000)),
]);
process.exit(0);
