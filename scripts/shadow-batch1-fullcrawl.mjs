#!/usr/bin/env node
/**
 * Shadow Batch 1 completion — full exhaustive crawl on fixed 50 Sanità IDs.
 * Single heavy worker. Fail-closed. Checkpoint/resume. Never touches live.
 */
process.env.POLICY_EXHAUSTIVE = process.env.POLICY_EXHAUSTIVE || "1";
process.env.OCR_ENABLED = process.env.OCR_ENABLED || "1";
process.env.SCAN_FAST = "0";
process.env.SCAN_ENGINE_LOCAL = "1";

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { requireShadowIsolation } from "../src/lib/shadow/guard.ts";
import { prisma } from "../src/lib/sanita/db-ready.ts";
import { analyzeLead } from "../src/lib/sanita/scan-engine.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";
import { terminateOcrWorker } from "../src/lib/sanita/ocr.ts";
import { closeMapsBrowserPool } from "../src/lib/sanita/playwright-maps.ts";
import { parseVersionMarkers, isLegacyLead } from "../src/lib/sanita/evidence-version.ts";

requireShadowIsolation();

const RUN_ID = process.env.SHADOW_RUN_ID || "shadow-batch1-fullcrawl-20260718";
const ROOT = process.cwd();
const LOCK = path.join(ROOT, "data/shadow/db/.shadow-worker.lock");
const HEARTBEAT = path.join(ROOT, "data/shadow/crawl/.heartbeat");
const CHECKPOINT = path.join(ROOT, "data/shadow/crawl/fullcrawl-checkpoint.json");
const RESULTS = path.join(ROOT, "data/shadow/crawl/fullcrawl-results.jsonl");
const DOCS = path.join(ROOT, "docs/shadow/batch1-completion");
const PER_LEAD_MS = Number(process.env.SHADOW_CRAWL_LEAD_MS || 12 * 60_000);
const MAX_LEADS = Number(process.env.SHADOW_CRAWL_MAX || 50);

fs.mkdirSync(path.dirname(HEARTBEAT), { recursive: true });
fs.mkdirSync(DOCS, { recursive: true });

function loadFixedIds() {
  const camp = JSON.parse(
    fs.readFileSync(path.join(ROOT, "docs/shadow/batch1/sanita-selection-campania.json"), "utf8")
  );
  const ven = JSON.parse(
    fs.readFileSync(path.join(ROOT, "docs/shadow/batch1/sanita-selection-veneto.json"), "utf8")
  );
  const ids = [
    ...camp.ids.map((id) => ({ id, region: "Campania" })),
    ...ven.ids.map((id) => ({ id, region: "Veneto" })),
  ];
  const hash = createHash("sha256").update(ids.map((x) => x.id).join(",")).digest("hex");
  return { ids, hash, seed: camp.meta?.seed ?? 20260718 };
}

function acquireLock() {
  if (fs.existsSync(LOCK)) {
    try {
      const meta = JSON.parse(fs.readFileSync(LOCK, "utf8"));
      process.kill(meta.pid, 0);
      console.error(`SHADOW GUARD REFUSED: worker active pid=${meta.pid}`);
      process.exit(78);
    } catch {
      /* stale */
    }
  }
  fs.writeFileSync(
    LOCK,
    JSON.stringify({ pid: process.pid, runId: RUN_ID, startedAt: new Date().toISOString() }, null, 2)
  );
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK);
  } catch {
    /* */
  }
}

function hb(step, extra = {}) {
  const payload = {
    runId: RUN_ID,
    pid: process.pid,
    host: os.hostname(),
    at: new Date().toISOString(),
    step,
    ...extra,
  };
  fs.writeFileSync(HEARTBEAT, JSON.stringify(payload));
  fs.writeFileSync(CHECKPOINT, JSON.stringify(payload, null, 2));
}

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

function classifyLegacy(oldV, newV, row) {
  if (oldV !== "HOT" && oldV !== "PUBLISHED") return null;
  if (row.identityStatus === "MISMATCH") return "IDENTITY_PROBLEM";
  if (row.technicalFailure) return "TECHNICALLY_UNVERIFIABLE";
  if (newV === "HOT") return "REAL_LEAD_CONFIRMED";
  if (newV === "PUBLISHED") return "PUBLICATION_CONFIRMED";
  if (!row.crawlComplete && row.website) return "POSSIBLE_NEW_FALSE_NEGATIVE";
  if (!row.website) return "INSUFFICIENT_PREVIOUS_EVIDENCE";
  if (oldV === "HOT" && newV === "REVIEW" && row.crawlComplete && !row.policyFound) {
    return "LIKELY_PREVIOUS_FALSE_POSITIVE";
  }
  return "HUMAN_REVIEW_REQUIRED";
}

async function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`TIMEOUT:${label}:${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(t);
  }
}

function onSignal(sig) {
  hb("interrupted", { signal: sig });
  releaseLock();
  process.exit(130);
}
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));

const fixed = loadFixedIds();
fs.writeFileSync(
  path.join(DOCS, "sanita-fixed-sample.md"),
  [
    "# Sanità fixed sample — Batch 1 completion",
    "",
    `**Seed:** \`${fixed.seed}\``,
    `**Selection hash:** \`${fixed.hash}\``,
    `**IDs:** ${fixed.ids.length} (25 Campania + 25 Veneto)`,
    "",
    "Same IDs as preliminary Batch 1. Do not reshuffle.",
    "",
    "## Campania",
    ...fixed.ids.filter((x) => x.region === "Campania").map((x) => `- \`${x.id}\``),
    "",
    "## Veneto",
    ...fixed.ids.filter((x) => x.region === "Veneto").map((x) => `- \`${x.id}\``),
    "",
  ].join("\n")
);

acquireLock();
hb("start", { selectionHash: fixed.hash });

const doneIds = new Set();
if (fs.existsSync(RESULTS)) {
  for (const line of fs.readFileSync(RESULTS, "utf8").split(/\n+/).filter(Boolean)) {
    try {
      const r = JSON.parse(line);
      if (r.id && !r.stopBatch) doneIds.add(r.id);
    } catch {
      /* */
    }
  }
} else {
  fs.writeFileSync(RESULTS, "");
}

const queue = fixed.ids.filter((x) => !doneIds.has(x.id)).slice(0, MAX_LEADS);
let stopReason = null;
const counters = { analyzed: 0, withPolicy: 0, hot: 0, review: 0 };

try {
  for (let i = 0; i < queue.length; i++) {
    const { id, region } = queue[i];
    hb(`crawl ${i + 1}/${queue.length}`, { id, region });
    const before = await prisma.lead.findUnique({ where: { id } });
    if (!before) {
      stopReason = `MISSING_LEAD:${id}`;
      break;
    }
    const oldVerdict = histVerdict(before.evidence);
    const t0 = Date.now();
    let err = null;
    try {
      await withTimeout(analyzeLead(before, counters), PER_LEAD_MS, id);
    } catch (e) {
      err = String(e?.message || e).slice(0, 200);
    }
    const after = await prisma.lead.findUnique({ where: { id } });
    const newVerdict = readVerdictToken(after?.evidence) || "REVIEW";
    const markers = parseVersionMarkers(after?.evidence);
    const pages = after?.pagesVisited ?? 0;
    const policyFound = Boolean(after?.policyFound);
    const crawlComplete = /\[CRAWL_COMPLETE:true\]/i.test(after?.evidence || "");
    const identityMatch = after?.evidence?.match(/\[IDENTITY:([A-Z_]+)\]/i);
    const identityStatus = identityMatch?.[1] || (crawlComplete ? "INSUFFICIENT" : "NOT_CHECKED");

    // Stop conditions
    if (newVerdict === "HOT" && identityStatus !== "OFFICIAL_CONFIRMED" && identityStatus !== "GROUP_OFFICIAL_CONFIRMED") {
      stopReason = "HOT_WITHOUT_VERIFIED_IDENTITY";
    }
    if (newVerdict === "HOT" && !crawlComplete) {
      stopReason = "HOT_INCOMPLETE_CRAWL";
    }
    if (newVerdict === "PUBLISHED" && !policyFound && !/autoassicur/i.test(after?.evidence || "")) {
      stopReason = "PUBLISHED_WITHOUT_POLICY";
    }

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
      pagesVisited: pages,
      policyFound,
      policyCompany: after?.policyCompany,
      policyNumber: after?.policyNumber,
      policyExpiry: after?.policyExpiry,
      technicalFailure: Boolean(err) || /Timeout|403|429|WAF|DNS|SSL/i.test(after?.evidence || ""),
      error: err,
      stillLegacy: isLegacyLead(after?.evidence),
      markers,
      durationMs: Date.now() - t0,
      evidenceHead: (after?.evidence || "").slice(0, 280),
      legacyClass: classifyLegacy(oldVerdict, newVerdict, {
        identityStatus,
        technicalFailure: Boolean(err),
        crawlComplete,
        website: after?.website,
        policyFound,
      }),
      stopBatch: Boolean(stopReason),
      stopReason,
    };
    fs.appendFileSync(RESULTS, JSON.stringify(row) + "\n");

    if (stopReason) break;
  }
} finally {
  hb("done", { stopReason });
  releaseLock();
  await Promise.race([
    Promise.all([
      terminateOcrWorker().catch(() => {}),
      closeMapsBrowserPool().catch(() => {}),
      prisma.$disconnect(),
    ]),
    new Promise((r) => setTimeout(r, 20_000)),
  ]);
}

// Aggregate summary from results file
const all = fs
  .readFileSync(RESULTS, "utf8")
  .split(/\n+/)
  .filter(Boolean)
  .map((l) => JSON.parse(l));

function regionMetrics(region) {
  const rows = all.filter((r) => r.region === region && !r.stopBatch);
  return {
    selected: 25,
    completed: rows.length,
    identityVerified: rows.filter((r) =>
      ["OFFICIAL_CONFIRMED", "GROUP_OFFICIAL_CONFIRMED"].includes(r.identityStatus)
    ).length,
    identityUnverified: rows.filter(
      (r) => !["OFFICIAL_CONFIRMED", "GROUP_OFFICIAL_CONFIRMED"].includes(r.identityStatus)
    ).length,
    crawlComplete: rows.filter((r) => r.crawlComplete).length,
    crawlIncomplete: rows.filter((r) => !r.crawlComplete).length,
    HOT: rows.filter((r) => r.newVerdict === "HOT").length,
    PUBLISHED: rows.filter((r) => r.newVerdict === "PUBLISHED").length,
    REVIEW: rows.filter((r) => r.newVerdict === "REVIEW").length,
    technicalFailure: rows.filter((r) => r.technicalFailure).length,
    avgPages: rows.length ? Math.round(rows.reduce((a, r) => a + (r.pagesVisited || 0), 0) / rows.length) : 0,
    avgDurationMs: rows.length ? Math.round(rows.reduce((a, r) => a + (r.durationMs || 0), 0) / rows.length) : 0,
    transitions: rows.reduce((acc, r) => {
      const k = `${r.oldVerdict}→${r.newVerdict}`;
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
  };
}

const summary = {
  runId: RUN_ID,
  selectionHash: fixed.hash,
  stopReason,
  completedAll: all.filter((r) => !r.stopBatch).length >= 50 && !stopReason,
  campania: regionMetrics("Campania"),
  veneto: regionMetrics("Veneto"),
  processed: all.filter((r) => !r.stopBatch).length,
};
fs.writeFileSync(path.join(DOCS, "fullcrawl-summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(stopReason ? 2 : summary.processed >= 50 ? 0 : 3);
