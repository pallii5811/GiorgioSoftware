#!/usr/bin/env node
/**
 * Shadow Batch 1 runner — gate re-evaluation on selected 100 leads.
 * Mode: applies Phase-2 identity/crawl/commercial/actionable gates to frozen snapshot
 * evidence WITHOUT inventing identity/completeness. Optional light HEAD probe only.
 * Never touches live DB. Single worker via lock file.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { requireShadowIsolation } from "../src/lib/shadow/guard.ts";
import { prisma } from "../src/lib/sanita/db-ready.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";
import { finalizeVerdict } from "../src/lib/sanita/finalize-verdict.ts";
import {
  isLegacyLead,
  isActionableEvidence,
  parseVersionMarkers,
} from "../src/lib/sanita/evidence-version.ts";
import { isInActionableSalesQueue } from "../src/lib/sanita/actionable-queue.ts";
import { scoreSanitaCommercial } from "../src/lib/sanita/commercial.ts";
import { scoreGareCommercial, estimateCauzione } from "../src/lib/gare/commercial.ts";
import {
  deriveCrawlComplete,
  crawlBlocksTerminalVerdict,
} from "../src/lib/evidence/contract.ts";
import {
  NOT_CHECKED_IDENTITY,
  identityBlocksTerminalVerdict,
} from "../src/lib/sanita/identity-evidence.ts";
import {
  parseTenderAwardDateObj,
  parseTenderBuyer,
  isStaleTenderAward,
} from "../src/lib/gare/display.ts";

const RUN_ID = process.env.SHADOW_RUN_ID || "shadow-batch1-20260718-rerun";
const ROOT = process.cwd();
const LOCK = path.join(ROOT, "data/shadow/db/.shadow-worker.lock");
const HEARTBEAT = path.join(ROOT, "data/shadow/db/.shadow-heartbeat");
const CHECKPOINT = path.join(ROOT, "data/shadow/batch1/checkpoint.json");
const OUT = path.join(ROOT, "data/shadow/batch1/results.jsonl");
const SUMMARY = path.join(ROOT, "docs/shadow/batch1/run-summary.json");

requireShadowIsolation();

function heartbeat(extra = {}) {
  const payload = {
    runId: RUN_ID,
    pid: process.pid,
    host: os.hostname(),
    at: new Date().toISOString(),
    commit: process.env.SHADOW_COMMIT || "ad38748ea59edd936b9c7def3a62fdd5ae9b4e2f",
    batch: "batch1",
    ...extra,
  };
  fs.writeFileSync(HEARTBEAT, JSON.stringify(payload), "utf8");
  fs.writeFileSync(CHECKPOINT, JSON.stringify(payload, null, 2), "utf8");
}

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  if (fs.existsSync(LOCK)) {
    const meta = JSON.parse(fs.readFileSync(LOCK, "utf8"));
    try {
      process.kill(meta.pid, 0);
      console.error(`SHADOW GUARD REFUSED: another worker pid=${meta.pid} run=${meta.runId}`);
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

function loadIds() {
  const packs = [
    ["sanita", "Campania", "docs/shadow/batch1/sanita-selection-campania.json"],
    ["sanita", "Veneto", "docs/shadow/batch1/sanita-selection-veneto.json"],
    ["gare", "Campania", "docs/shadow/batch1/gare-selection-campania.json"],
    ["gare", "Veneto", "docs/shadow/batch1/gare-selection-veneto.json"],
  ];
  const out = [];
  for (const [engine, region, p] of packs) {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    for (const id of j.ids) out.push({ engine, region, id });
  }
  return out;
}

async function lightProbe(url) {
  if (!url) return { ok: false, status: null, error: "no_url" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": "LeadSniper-ShadowBatch1/1.0" },
    });
    return { ok: res.ok || (res.status >= 200 && res.status < 400), status: res.status, error: null };
  } catch (e) {
    return { ok: false, status: null, error: String(e?.name || e).slice(0, 80) };
  } finally {
    clearTimeout(t);
  }
}

function inferCrawlFromLead(lead) {
  const pages = lead.pagesVisited || 0;
  const reachable = lead.websiteReachable;
  const hasSite = Boolean(lead.website?.trim());
  // Never invent completeness=true for legacy — fail closed
  return deriveCrawlComplete({
    identityVerified: false,
    sitemapStatus: hasSite ? "NOT_DISCOVERED" : "NOT_PRESENT",
    htmlQueueExhausted: false,
    relevantLinksProcessed: false,
    relevantDocumentsProcessed: false,
    jsonEndpointsProcessed: false,
    sameHostScriptsProcessed: false,
    unresolvedRelevantUrls: hasSite ? 1 : 0,
    failedRelevantUrls: reachable === false ? 1 : 0,
    unreadableRelevantDocuments: 0,
    criticalOcrDoubts: /ocr|illeggibil/i.test(lead.evidence || "") ? 1 : 0,
    urlCapReached: false,
    timeCapReached: false,
  });
}

async function processSanita(lead, region) {
  const t0 = Date.now();
  const oldVerdict = histVerdict(lead.evidence);
  const oldScore = lead.leadScore;
  const oldWebsite = lead.website;
  const probe = await lightProbe(lead.website);
  const identity = NOT_CHECKED_IDENTITY;
  const crawl = inferCrawlFromLead({
    ...lead,
    websiteReachable: probe.ok ? true : lead.websiteReachable,
  });
  const idBlock = identityBlocksTerminalVerdict(identity);
  const crawlBlock = crawlBlocksTerminalVerdict(crawl);

  let candidate = readVerdictToken(lead.evidence) || "REVIEW";
  // Historical HOT/PUB cannot remain terminal without CURRENT verified identity+crawl
  const fin = finalizeVerdict({
    verdict: candidate === "PUBLISHED" ? "PUBLISHED" : candidate === "HOT" ? "HOT" : "REVIEW",
    evidenceBody: lead.evidence || "",
    pagesVisited: lead.pagesVisited || 0,
    websiteReachable: probe.ok ? true : lead.websiteReachable,
    website: lead.website,
    policyCompany: lead.policyCompany,
    policyExpiry: lead.policyExpiry,
    policyObsolete: /scaduta|obsolete/i.test(lead.evidence || ""),
    policyExhaustive: false, // never invent
    needsOcrReview: crawl.criticalOcrDoubts > 0,
    crawlCompleteness: crawl,
  });

  let newVerdict = fin.verdict;
  if (idBlock && (newVerdict === "HOT" || newVerdict === "PUBLISHED")) {
    newVerdict = "REVIEW";
  }
  if (crawlBlock && newVerdict === "HOT") {
    newVerdict = "REVIEW";
  }
  // Keep quarantine: still legacy until full rescan certifies CURRENT
  const stillLegacy = isLegacyLead(lead.evidence);
  const commercial = scoreSanitaCommercial({
    verdict: newVerdict,
    policyObsolete: /scaduta/i.test(lead.evidence || ""),
    hasPhone: Boolean(lead.phone),
    hasEmail: Boolean(lead.email || lead.pec),
    hasWebsite: Boolean(lead.website),
    pagesVisited: lead.pagesVisited || 0,
    crawlComplete: crawl.complete,
    companyName: lead.companyName,
  });

  const actionableOld =
    (oldVerdict === "HOT" || oldVerdict === "PUBLISHED") && !stillLegacy;
  const actionableNew = isInActionableSalesQueue({
    type: "HEALTHCARE",
    evidence: lead.evidence,
    leadScore: commercial.score,
  });

  const priorityReview = [
    oldVerdict === "HOT" && newVerdict === "PUBLISHED",
    oldVerdict === "PUBLISHED" && newVerdict === "HOT",
    oldVerdict === "REVIEW" && (newVerdict === "HOT" || newVerdict === "PUBLISHED"),
    oldWebsite !== lead.website,
    Boolean(idBlock),
    /scaduta/i.test(lead.evidence || ""),
    /autoassicur/i.test(lead.evidence || ""),
    newVerdict === "HOT",
  ].some(Boolean);

  // Stop conditions
  if (newVerdict === "HOT" && !identity.verified) {
    return { stop: "HOT_WITHOUT_IDENTITY", leadId: lead.id };
  }
  if (newVerdict === "HOT" && !crawl.complete) {
    return { stop: "HOT_INCOMPLETE_CRAWL", leadId: lead.id };
  }
  if (newVerdict === "PUBLISHED" && !lead.policyFound && !/autoassicur/i.test(lead.evidence || "")) {
    return { stop: "PUBLISHED_WITHOUT_EVIDENCE", leadId: lead.id };
  }

  return {
    stop: null,
    engine: "sanita",
    region,
    id: lead.id,
    companyName: lead.companyName,
    city: lead.city,
    category: lead.category,
    oldVerdict,
    newVerdict,
    oldScore,
    newScore: commercial.score,
    commercialTier: commercial.tier,
    oldWebsite,
    newWebsite: lead.website,
    identityStatus: identity.status,
    identityBlock: idBlock,
    crawlComplete: crawl.complete,
    sitemapStatus: crawl.sitemapStatus,
    probe,
    stillLegacy,
    actionableOld: Boolean(actionableOld),
    actionableNew: Boolean(actionableNew),
    requiresHumanReview: true,
    priorityReview,
    motivation: fin.downgraded
      ? fin.evidenceBody.slice(0, 240)
      : commercial.reasons.join("; ").slice(0, 240),
    technicalFailures: probe.error ? [probe.error] : [],
    cost: 0,
    durationMs: Date.now() - t0,
    policyCompany: lead.policyCompany,
    policyNumber: lead.policyNumber,
    policyExpiry: lead.policyExpiry,
    pagesVisited: lead.pagesVisited,
    evidenceHead: (lead.evidence || "").slice(0, 200),
    markers: parseVersionMarkers(lead.evidence),
  };
}

async function processGare(lead, region) {
  const t0 = Date.now();
  const awardDate = parseTenderAwardDateObj(lead.evidence);
  const buyer = parseTenderBuyer(lead.evidence);
  const winner = lead.tenderWinner || lead.companyName;
  const winnerIsBuyer =
    buyer && winner && buyer.toLowerCase().includes(String(winner).toLowerCase().slice(0, 12));
  const officialSource = /anac|ocds|jsonl|bdncp/i.test(lead.evidence || "") || Boolean(lead.tenderCig);
  const stale = isStaleTenderAward(lead.evidence);
  const amount = Number(lead.tenderAmount || 0);
  const cauzione = estimateCauzione(amount);

  let blocked = null;
  const winnerNorm = String(winner || "").trim().toLowerCase();
  const buyerNorm = String(buyer || "").trim().toLowerCase();
  const exactBuyerWinner = Boolean(winnerNorm && buyerNorm && winnerNorm === buyerNorm);
  if (exactBuyerWinner) blocked = "buyer_as_winner";
  if (!winner) blocked = "missing_winner";
  if (!officialSource) blocked = blocked || "no_official_source";
  if (stale) blocked = blocked || "stale_award";

  const commercial = blocked
    ? {
        score: 0,
        tier: "NOT_ACTIONABLE",
        reasons: [blocked],
        verifiedFacts: [],
        inferences: [],
        missingInformation: [blocked],
        recommendedAction: "Non actionable",
      }
    : scoreGareCommercial({
        awardDate,
        amount,
        hasPhone: Boolean(lead.phone),
        hasEmail: Boolean(lead.email),
        hasWebsite: Boolean(lead.website),
        relevance: /GARE_HIGH/i.test(lead.category || "")
          ? "HIGH"
          : /GARE_MEDIUM/i.test(lead.category || "")
            ? "MEDIUM"
            : "LOW",
        winnerIdentified: Boolean(winner),
        officialSource,
      });

  const oldActionable = (lead.leadScore || 0) >= 50 && !stale;
  const newActionable = commercial.tier === "VERY_HIGH" || commercial.tier === "HIGH" || commercial.tier === "MEDIUM";

  // Hard stop only on exact buyer==winner contamination
  if (exactBuyerWinner) {
    return { stop: "BUYER_AS_WINNER", leadId: lead.id, engine: "gare", region };
  }

  return {
    stop: null,
    engine: "gare",
    region,
    id: lead.id,
    cig: lead.tenderCig,
    object: (lead.tenderObject || "").slice(0, 160),
    winner,
    buyer,
    regionBasis: ["buyer_sa"],
    oldScore: lead.leadScore,
    newScore: commercial.score,
    tier: commercial.tier,
    amount,
    amountKind: amount > 0 ? "FACT" : "MISSING",
    cauzioneValue: cauzione.value,
    cauzioneKind: cauzione.kind,
    awardDate: awardDate?.toISOString?.() || null,
    stale,
    blocked,
    officialSource,
    actionableOld: oldActionable,
    actionableNew: newActionable && !blocked,
    requiresHumanReview: true,
    priorityReview: Boolean(blocked) || cauzione.kind === "ESTIMATE",
    motivation: commercial.reasons.join("; ").slice(0, 240),
    verifiedFacts: commercial.verifiedFacts,
    inferences: commercial.inferences,
    cost: 0,
    durationMs: Date.now() - t0,
    phone: Boolean(lead.phone),
    email: Boolean(lead.email),
    category: lead.category,
    city: lead.city,
    companyName: lead.companyName,
  };
}

async function main() {
  acquireLock();
  heartbeat({ step: "start" });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, "", "utf8");

  const items = loadIds();
  const results = [];
  let stopReason = null;

  try {
    for (let i = 0; i < items.length; i++) {
      const { engine, region, id } = items[i];
      heartbeat({ step: `item-${i + 1}/${items.length}`, id, engine, region });
      const lead = await prisma.lead.findUnique({ where: { id } });
      if (!lead) {
        stopReason = `MISSING_LEAD:${id}`;
        break;
      }
      const row =
        engine === "sanita" ? await processSanita(lead, region) : await processGare(lead, region);
      if (row.stop) {
        stopReason = row.stop;
        results.push(row);
        fs.appendFileSync(OUT, JSON.stringify(row) + "\n");
        break;
      }
      results.push(row);
      fs.appendFileSync(OUT, JSON.stringify(row) + "\n");
    }
  } finally {
    heartbeat({ step: "done", stopReason });
    releaseLock();
    await prisma.$disconnect().catch(() => {});
  }

  const by = {
    sanitaCampania: results.filter((r) => r.engine === "sanita" && r.region === "Campania"),
    sanitaVeneto: results.filter((r) => r.engine === "sanita" && r.region === "Veneto"),
    gareCampania: results.filter((r) => r.engine === "gare" && r.region === "Campania"),
    gareVeneto: results.filter((r) => r.engine === "gare" && r.region === "Veneto"),
  };

  function metrics(rows, kind, selectedTarget) {
    const base = {
      selected: selectedTarget,
      started: rows.length,
      completed: rows.filter((r) => !r.stop).length,
      technicalFailure: rows.filter((r) => (r.technicalFailures || []).length).length,
      retry: 0,
      cost: rows.reduce((a, r) => a + (r.cost || 0), 0),
      durationMs: rows.reduce((a, r) => a + (r.durationMs || 0), 0),
      oldActionable: rows.filter((r) => r.actionableOld).length,
      newActionable: rows.filter((r) => r.actionableNew).length,
      priorityReview: rows.filter((r) => r.priorityReview).length,
      stopConditions: rows.filter((r) => r.stop).map((r) => r.stop),
    };
    if (kind === "sanita") {
      return {
        ...base,
        HOT: rows.filter((r) => r.newVerdict === "HOT").length,
        PUBLISHED: rows.filter((r) => r.newVerdict === "PUBLISHED").length,
        REVIEW: rows.filter((r) => r.newVerdict === "REVIEW").length,
        crawlIncomplete: rows.filter((r) => r.crawlComplete === false).length,
        identityUnverified: rows.filter((r) => r.identityStatus !== "OFFICIAL_CONFIRMED").length,
      };
    }
    return {
      ...base,
      VERY_HIGH: rows.filter((r) => r.tier === "VERY_HIGH").length,
      HIGH: rows.filter((r) => r.tier === "HIGH").length,
      MEDIUM: rows.filter((r) => r.tier === "MEDIUM").length,
      LOW: rows.filter((r) => r.tier === "LOW").length,
      NOT_ACTIONABLE: rows.filter((r) => r.tier === "NOT_ACTIONABLE").length,
      cauzioneEstimate: rows.filter((r) => r.cauzioneKind === "ESTIMATE").length,
      blocked: rows.filter((r) => r.blocked).length,
    };
  }

  const transitions = {};
  for (const r of results.filter((x) => x.engine === "sanita" && !x.stop)) {
    const k = `${r.oldVerdict}→${r.newVerdict}`;
    transitions[k] = (transitions[k] || 0) + 1;
  }

  const summary = {
    runId: RUN_ID,
    mode: "gate-reeval+light-probe",
    stopReason,
    completed: !stopReason,
    metrics: {
      sanitaCampania: metrics(by.sanitaCampania, "sanita", 25),
      sanitaVeneto: metrics(by.sanitaVeneto, "sanita", 25),
      gareCampania: metrics(by.gareCampania, "gare", 25),
      gareVeneto: metrics(by.gareVeneto, "gare", 2),
    },
    transitions,
    fingerprint: createHash("sha256").update(JSON.stringify(results.map((r) => r.id))).digest("hex").slice(0, 16),
  };
  fs.mkdirSync(path.dirname(SUMMARY), { recursive: true });
  fs.writeFileSync(SUMMARY, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (stopReason) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  releaseLock();
  process.exit(1);
});
