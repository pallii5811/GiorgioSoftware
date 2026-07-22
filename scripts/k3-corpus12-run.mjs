/**
 * k3 — Corpus stop-ship dei 12: runner + monitor + gate.
 *
 * Lancia la v3 SOLO sui 12 lead del corpus (REVALIDATE_IDS), concurrency=1,
 * resume su frontier esistente, OCR attivo, apply-live=0, discovery off.
 * Checkpoint obbligatori dopo 3/6/9/12 lead gestiti. STOP automatico su:
 * OCR_RENDERER_MISSING, falso HOT (frontier incompleta), falso PUB (no
 * first-party evidence+hash), TECHNICAL_BLOCKED terminale, perdita checkpoint.
 * Al termine: audit completo + CORPUS12_RESULTS.json con verdict GATE.
 *
 * NON tocca systemd, NON avvia gli 877.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = process.env.K3_WORKDIR || "/opt/leadsniper-revalidate";
const APP = process.env.K3_APP || path.join(W, "app");
const CHECKPOINT = process.env.REVALIDATE_CHECKPOINT || path.join(W, "data/revalidation/checkpoint.json");
const RESULTS_DIR = path.join(W, "data/revalidation/results");
const OUT_JSON = process.env.K3_OUT || path.join(W, "data/k3-stopship/CORPUS12_RESULTS.json");
const GLOBAL_TIMEOUT_MS = Number(process.env.K3_GLOBAL_TIMEOUT_MS || 4 * 3_600_000);

const CORPUS = [
  "cmqkld5s700a8108eti0nofjv", // Villa Maione — DNS morto (RC-01)
  "cmqkld5rx009p108edj6t9krw",
  "cmql46eia000ac9w78xh0rxdl", // Nuova Alba — WAF 403 (RC-02)
  "cmqkld5t300av108e5rrr47s9",
  "cmqkld5s3009z108e1yj01zqy",
  "cmqkld5s0009u108eghihpoxi",
  "cmqkld5s300a0108e8p1p3xxg",
  "cmqklex5e00b3108e2zcdos1w",
  "cmqklex5g00b6108ejom1shk0",
  "cmqkn3ghj0002xnfpr553khla",
  "cmqkld5sa00af108epednu868",
  "cmqkld5t000ao108esg4xv094", // ICM Agropoli (fix RC-run-01: id spurio ...5rrr47s9 era typo di Montesano)
];

const CHECKPOINT_MARKS = [3, 6, 9, 12];
const log = (obj) => {
  const line = JSON.stringify({ t: new Date().toISOString(), ...obj });
  console.log(line);
};

const state = {
  startedAt: new Date().toISOString(),
  firstOutcome: {}, // id → {processingState, kind, at}
  checkpoints: [],
  stopReasons: [],
  audits: {},
};

function readCp() {
  try {
    return JSON.parse(fs.readFileSync(CHECKPOINT, "utf8"));
  } catch (e) {
    return null;
  }
}

function resultRow(id) {
  for (const p of [path.join(RESULTS_DIR, `${id}.json`)]) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      /* */
    }
  }
  return null;
}

const UNRESOLVED_STATES = new Set([
  "DISCOVERED",
  "QUEUED",
  "FETCHING",
  "FETCHED",
  "RENDERED",
  "PARSED",
  "RETRY_PENDING",
]);

function hostOf(u) {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}
function sameRegistrable(a, b) {
  const reg = (h) => h.split(".").slice(-2).join(".");
  return reg(a) === reg(b);
}

let frontierStoreMod = null;
async function store() {
  if (!frontierStoreMod) frontierStoreMod = await import("../src/lib/sanita/frontier-store.ts");
  return frontierStoreMod;
}

/** Apre il frontier UNA sola volta, raccoglie tutto, chiude SEMPRE (niente handle leaked). */
async function inspectFrontier(fp) {
  const {
    openFrontierStore,
    closeFrontierStore,
    deriveCrawlCompleteness,
    listNodes,
    aggregatePersistedEvidence,
  } = await store();
  const db = openFrontierStore(fp);
  try {
    const runId = db
      .prepare("SELECT id FROM CrawlRun ORDER BY rowid DESC LIMIT 1")
      .get()?.id;
    if (!runId) return { runId: null };
    return {
      runId,
      comp: deriveCrawlCompleteness(runId),
      nodes: listNodes(runId),
      agg: aggregatePersistedEvidence(runId),
    };
  } finally {
    closeFrontierStore();
  }
}

/** Audit anti falso-HOT / falso-PUB su UN lead terminale. Ritorna lista violazioni. */
async function auditTerminal(id, processingState) {
  const violations = [];
  const row = resultRow(id);
  if (!row) return [`result row assente per ${id}`];
  const frontierPaths = (row.frontierPaths || []).filter((p) => p && fs.existsSync(p));

  if (processingState === "HOT_VERIFIED") {
    // dual pass indipendente obbligatorio (REVALIDATE_DUAL_HOT=1 nel child)
    const p1 = row.pass1?.processingState;
    const p2 = row.pass2?.processingState;
    if (p1 !== "HOT_VERIFIED" || p2 !== "HOT_VERIFIED") {
      violations.push(`dual HOT non concorde (p1=${p1} p2=${p2})`);
    }
    if (!frontierPaths.length) violations.push("frontier HOT mancante su disco");
    for (const fp of frontierPaths) {
      let info;
      try {
        info = await inspectFrontier(fp);
      } catch (e) {
        violations.push(`audit frontier fallito: ${String(e).slice(0, 150)}`);
        continue;
      }
      if (!info.runId) {
        violations.push(`CrawlRun assente: ${fp}`);
        continue;
      }
      const c = info.comp || {};
      if (!c.complete) {
        violations.push(
          `frontier incompleta ma HOT emesso (unresolved=${c.unresolvedRelevantUrls} failed=${c.failedRelevantUrls} unreadable=${c.unreadableRelevantDocuments} ocrDoubts=${c.criticalOcrDoubts} sitemap=${c.sitemapStatus} urlCap=${c.urlCapReached} timeCap=${c.timeCapReached})`
        );
      }
      const rel = info.nodes.filter(
        (n) => n.relevance === "critical" || n.relevance === "relevant"
      );
      const unresolved = rel.filter((n) => UNRESOLVED_STATES.has(n.state));
      const blocked = rel.filter((n) => n.state === "TECHNICAL_BLOCKED");
      if (unresolved.length) {
        violations.push(`${unresolved.length} nodi rilevanti irrisolti ma HOT emesso`);
      }
      if (blocked.length) {
        violations.push(`${blocked.length} nodi rilevanti TECHNICAL_BLOCKED ma HOT emesso`);
      }
      if (info.agg?.policyFound) violations.push("HOT emesso ma policyFound nel frontier");
    }
  }

  if (String(processingState).startsWith("PUBLISHED")) {
    if (!row.policyFound) violations.push("PUBLISHED senza policyFound");
    if (!String(row.fullEvidence || "").trim()) violations.push("PUBLISHED senza fullEvidence");
    let withPolicy = null;
    for (const fp of frontierPaths) {
      try {
        const info = await inspectFrontier(fp);
        if (info.agg?.policyFound) {
          withPolicy = info;
          break;
        }
      } catch (e) {
        violations.push(`audit evidence PUB fallito: ${String(e).slice(0, 150)}`);
      }
    }
    if (!withPolicy) {
      violations.push("evidence frontier senza policyFound (first-party mancante)");
    } else {
      if (!String(withPolicy.agg.policyText || "").trim()) {
        violations.push("policyText vuoto nel frontier");
      }
      if (!/^[0-9a-f]{64}$/i.test(withPolicy.agg.contentHash || "")) {
        violations.push("hash SHA-256 documento polizza assente nel frontier");
      }
      const policyUrl = withPolicy.agg.policyUrl || "";
      if (!policyUrl) {
        violations.push("policyUrl assente");
      } else {
        const siteHost = hostOf(row.website || "");
        const polHost = hostOf(policyUrl);
        if (siteHost && polHost && !sameRegistrable(siteHost, polHost)) {
          violations.push(`policyUrl non first-party: ${polHost} vs sito ufficiale ${siteHost}`);
        }
      }
    }
  }
  return violations;
}

async function checkpointReport(mark) {
  const cp = readCp() || { terminal: {}, retryQueue: {}, stats: {} };
  const corpusTerminal = CORPUS.filter((id) => cp.terminal?.[id]);
  const corpusRetry = CORPUS.filter((id) => cp.retryQueue?.[id]);
  const report = {
    mark,
    at: new Date().toISOString(),
    corpusTerminal: corpusTerminal.length,
    corpusRetry: corpusRetry.length,
    byState: {},
    stats: cp.stats,
    retryReasons: {},
  };
  for (const id of corpusTerminal) {
    const st = cp.terminal[id].processingState;
    report.byState[st] = (report.byState[st] || 0) + 1;
  }
  for (const id of corpusRetry) {
    const r = cp.retryQueue[id].lastError || cp.retryQueue[id].lastReason || "?";
    report.retryReasons[r] = (report.retryReasons[r] || 0) + 1;
  }
  state.checkpoints.push(report);
  log({ event: "k3_checkpoint", ...report });

  // STOP conditions valutate a ogni checkpoint
  if (report.byState.TECHNICAL_BLOCKED) {
    state.stopReasons.push(`TECHNICAL_BLOCKED terminale presente (${report.byState.TECHNICAL_BLOCKED})`);
  }
  // audit terminali non ancora auditati
  for (const id of corpusTerminal) {
    if (state.audits[id]) continue;
    const st = cp.terminal[id].processingState;
    const violations = await auditTerminal(id, st);
    state.audits[id] = { processingState: st, violations };
    if (violations.length) {
      state.stopReasons.push(`${id} (${st}): ${violations.join("; ")}`);
      log({ event: "k3_audit_violation", id, st, violations });
    } else {
      log({ event: "k3_audit_ok", id, st });
    }
  }
}

// ----------------------------- run -----------------------------------------
const cp0 = readCp();
log({
  event: "k3_corpus12_start",
  corpus: CORPUS.length,
  checkpointSha: cp0 ? "present" : "MISSING",
  terminalBefore: Object.keys(cp0?.terminal || {}).length,
  retryBefore: Object.keys(cp0?.retryQueue || {}).length,
});
if (!cp0) {
  console.error("checkpoint illeggibile — STOP prima di consumare lead");
  process.exit(2);
}

// Lead del corpus già terminali prima di questo run (es. REVIEW_HUMAN legittimo):
// contati come gestiti dal checkpoint esistente + audit subito. Senza questo il
// gate handled12 non sarebbe mai raggiungibile (nessun lead_done per loro).
for (const id of CORPUS) {
  const t = cp0.terminal?.[id];
  if (!t) continue;
  state.firstOutcome[id] = {
    processingState: t.processingState,
    kind: "terminal",
    at: t.finishedAt,
    preExisting: true,
  };
  const violations = await auditTerminal(id, t.processingState);
  state.audits[id] = { processingState: t.processingState, violations, preExisting: true };
  if (violations.length) state.stopReasons.push(`preexisting ${id}: ${violations.join("; ")}`);
  log({ event: "k3_preseed_terminal", id, st: t.processingState, violations });
}

const childEnv = {
  ...process.env,
  REVALIDATE_IDS: CORPUS.join(","),
  TOTAL_WORKERS: "1",
  REVALIDATE_CONCURRENCY: "1",
  REVALIDATE_DUAL_HOT: "1", // seconda verifica indipendente obbligatoria per HOT
  OCR_ENABLED: "1",
  POLICY_EXHAUSTIVE: "1",
  SCAN_FAST: "0",
  PDFTOPPM_PATH: process.env.PDFTOPPM_PATH || "/usr/bin/pdftoppm",
  REVALIDATE_CHECKPOINT: CHECKPOINT,
  REVALIDATE_OUT_DIR: path.join(W, "data/revalidation"),
  FRONTIER_DB_PATH: path.join(W, "data/revalidation/frontiers/boot.sqlite"),
  DATABASE_URL: process.env.DATABASE_URL || `file:${W}/shadow-revalidate.db`,
  CRAWL_RUN_MAX_WALL_CLOCK_MS: process.env.CRAWL_RUN_MAX_WALL_CLOCK_MS || "1800000",
  REVALIDATE_LEAD_WALL_MS: process.env.REVALIDATE_LEAD_WALL_MS || "1800000",
  NODE_OPTIONS: "--max-old-space-size=3072",
};

const child = spawn("npx", ["tsx", "scripts/production-revalidate-sanita-v3.mjs"], {
  cwd: APP,
  env: childEnv,
  stdio: ["ignore", "pipe", "pipe"],
});

let stderrTail = "";
child.stderr.on("data", (d) => {
  stderrTail = (stderrTail + d.toString()).slice(-6000);
  process.stderr.write(d);
  if (/OCR_RENDERER_MISSING/.test(stderrTail)) {
    state.stopReasons.push("OCR_RENDERER_MISSING ricomparso");
  }
});

let stopRequested = false;
function requestStop(why) {
  if (stopRequested) return;
  stopRequested = true;
  log({ event: "k3_stop_requested", why });
  try {
    child.kill("SIGTERM");
  } catch {
    /* */
  }
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* */
    }
  }, 120_000).unref();
}

const globalTimer = setTimeout(() => {
  state.stopReasons.push(`global timeout ${GLOBAL_TIMEOUT_MS}ms`);
  requestStop("global_timeout");
}, GLOBAL_TIMEOUT_MS);
globalTimer.unref?.();

let buf = "";
child.stdout.on("data", (d) => {
  process.stdout.write(d);
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line.startsWith("{")) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    handleEvent(ev).catch((e) => log({ event: "k3_monitor_error", e: String(e).slice(0, 200) }));
  }
});

async function handleEvent(ev) {
  if (ev.event === "lead_done" && CORPUS.includes(ev.id) && !state.firstOutcome[ev.id]) {
    state.firstOutcome[ev.id] = {
      processingState: ev.processingState,
      kind: ev.kind,
      at: new Date().toISOString(),
    };
    // audit immediato sui terminali commerciali (falso HOT/PUB → STOP subito)
    if (ev.kind === "terminal" || ev.processingState === "HOT_VERIFIED" || String(ev.processingState).startsWith("PUBLISHED")) {
      const violations = await auditTerminal(ev.id, ev.processingState);
      state.audits[ev.id] = { processingState: ev.processingState, violations };
      if (violations.length) {
        state.stopReasons.push(`${ev.id} (${ev.processingState}): ${violations.join("; ")}`);
      }
    }
    const done = Object.keys(state.firstOutcome).length;
    log({ event: "k3_progress", done, of: CORPUS.length, last: ev.id, st: ev.processingState });
    if (CHECKPOINT_MARKS.includes(done)) await checkpointReport(done);
    if (state.stopReasons.length) requestStop("stop_condition");
    else if (done >= CORPUS.length) requestStop("corpus_complete");
  }
}

const exitCode = await new Promise((resolve) => {
  child.on("close", (code) => resolve(code ?? -1));
  setTimeout(() => resolve(-2), GLOBAL_TIMEOUT_MS + 180_000);
});
clearTimeout(globalTimer);
log({ event: "k3_child_exit", exitCode, stopRequested });

// ----------------------------- final audit + gate ---------------------------
const cpF = readCp() || { terminal: {}, retryQueue: {}, stats: {} };
const final = {
  verdict: "NON PASS",
  stoppedAt: new Date().toISOString(),
  startedAt: state.startedAt,
  exitCode,
  stopReasons: state.stopReasons,
  corpus: CORPUS,
  firstOutcome: state.firstOutcome,
  checkpoints: state.checkpoints,
  audits: state.audits,
  terminal: {},
  retry: {},
  gate: {},
};
const byState = {};
for (const id of CORPUS) {
  if (cpF.terminal?.[id]) {
    final.terminal[id] = cpF.terminal[id];
    byState[cpF.terminal[id].processingState] = (byState[cpF.terminal[id].processingState] || 0) + 1;
  } else if (cpF.retryQueue?.[id]) {
    final.retry[id] = {
      lastReason: cpF.retryQueue[id].lastReason,
      lastError: cpF.retryQueue[id].lastError,
      attempts: cpF.retryQueue[id].attempts,
    };
  }
}
final.byState = byState;

const handled = Object.keys(state.firstOutcome).length;
const falseHot = Object.entries(state.audits).filter(([, a]) =>
  a.violations.some((v) => /HOT|frontier|nodi irrisolti/i.test(v))
).length;
const falsePub = Object.entries(state.audits).filter(([, a]) =>
  a.violations.some((v) => /PUBLISHED|policy|hash|first-party/i.test(v))
).length;
const techTerminal = Object.values(final.terminal).filter(
  (t) => t.processingState === "TECHNICAL_BLOCKED"
).length;
const auditViolations = Object.values(state.audits).reduce((acc, a) => acc + a.violations.length, 0);

final.gate = {
  handled12: handled === 12,
  internalTechnicalTerminal: techTerminal,
  ocrRendererMissing: state.stopReasons.filter((r) => /OCR_RENDERER_MISSING/.test(r)).length,
  falseHot,
  falsePub,
  auditViolations,
  checkpointPreserved: Boolean(cpF && cpF.version >= 3),
};
const pass =
  final.gate.handled12 &&
  techTerminal === 0 &&
  final.gate.ocrRendererMissing === 0 &&
  auditViolations === 0 &&
  state.stopReasons.length === 0;
final.verdict = pass ? "PASS" : "NON PASS";

fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify(final, null, 1));
log({ event: "k3_corpus12_end", verdict: final.verdict, byState, gate: final.gate });
process.exit(pass ? 0 : 1);
