/**
 * k3 — Runner persistente rivalidazione 877 in shadow.
 *
 * Avvia la v3 su tutto il checkpoint esistente (resume automatico).
 * apply-live=0, discovery off. STOP solo su falsi HOT/PUB, OCR_RENDERER_MISSING,
 * errore sistemico o richiesta esplicita via file stop.
 * Scrive stato in data/k3-stopship/REVALIDATE_877_STATUS.json per la UI.
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
const STATUS_JSON = process.env.K3_STATUS || path.join(W, "data/k3-stopship/REVALIDATE_877_STATUS.json");
const STOP_FILE = process.env.K3_STOP_FILE || path.join(W, "data/k3-stopship/STOP_877");
const GLOBAL_TIMEOUT_MS = Number(process.env.K3_GLOBAL_TIMEOUT_MS || 24 * 3_600_000);

const log = (obj) => console.log(JSON.stringify({ t: new Date().toISOString(), ...obj }));
const state = {
  startedAt: new Date().toISOString(),
  stopReasons: [],
  audits: {},
  terminalCount: 0,
  retryCount: 0,
  lastProgressAt: Date.now(),
};

function readCp() { try { return JSON.parse(fs.readFileSync(CHECKPOINT, "utf8")); } catch { return null; } }
function resultRow(id) { try { return JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${id}.json`), "utf8")); } catch { return null; } }
function writeStatus(extra = {}) {
  const cp = readCp() || { terminal: {}, retryQueue: {}, inProgress: {}, stats: {} };
  const payload = {
    job: "revalidate-877",
    startedAt: state.startedAt,
    updatedAt: new Date().toISOString(),
    stopReasons: state.stopReasons,
    checkpoint: {
      terminal: Object.keys(cp.terminal || {}).length,
      retry: Object.keys(cp.retryQueue || {}).length,
      inProgress: Object.keys(cp.inProgress || {}).length,
      processed: cp.stats?.processed ?? 0,
    },
    ...extra,
  };
  fs.mkdirSync(path.dirname(STATUS_JSON), { recursive: true });
  fs.writeFileSync(STATUS_JSON, JSON.stringify(payload, null, 1));
}

const UNRESOLVED_STATES = new Set(["DISCOVERED","QUEUED","FETCHING","FETCHED","RENDERED","PARSED","RETRY_PENDING"]);
function hostOf(u) { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; } }
function sameRegistrable(a, b) { const reg = (h) => h.split(".").slice(-2).join("."); return reg(a) === reg(b); }

let frontierStoreMod = null;
async function store() {
  if (!frontierStoreMod) frontierStoreMod = await import("../src/lib/sanita/frontier-store.ts");
  return frontierStoreMod;
}
async function inspectFrontier(fp) {
  const { openFrontierStore, closeFrontierStore, deriveCrawlCompleteness, listNodes, aggregatePersistedEvidence } = await store();
  const db = openFrontierStore(fp);
  try {
    const runId = db.prepare("SELECT id FROM CrawlRun ORDER BY rowid DESC LIMIT 1").get()?.id;
    if (!runId) return { runId: null };
    return { runId, comp: deriveCrawlCompleteness(runId), nodes: listNodes(runId), agg: aggregatePersistedEvidence(runId) };
  } finally { closeFrontierStore(); }
}

async function auditTerminal(id, processingState) {
  const violations = [];
  const row = resultRow(id);
  if (!row) return [`result row assente per ${id}`];
  const frontierPaths = (row.frontierPaths || []).filter((p) => p && fs.existsSync(p));

  if (processingState === "HOT_VERIFIED") {
    const p1 = row.pass1?.processingState;
    const p2 = row.pass2?.processingState;
    if (p1 !== "HOT_VERIFIED" || p2 !== "HOT_VERIFIED") violations.push(`dual HOT non concorde (p1=${p1} p2=${p2})`);
    if (!frontierPaths.length) violations.push("frontier HOT mancante su disco");
    for (const fp of frontierPaths) {
      let info;
      try { info = await inspectFrontier(fp); } catch (e) { violations.push(`audit frontier fallito: ${String(e).slice(0,150)}`); continue; }
      if (!info.runId) { violations.push(`CrawlRun assente: ${fp}`); continue; }
      const c = info.comp || {};
      if (!c.complete) violations.push(`frontier incompleta ma HOT emesso`);
      const rel = info.nodes.filter((n) => n.relevance === "critical" || n.relevance === "relevant");
      const unresolved = rel.filter((n) => UNRESOLVED_STATES.has(n.state));
      const blocked = rel.filter((n) => n.state === "TECHNICAL_BLOCKED");
      if (unresolved.length) violations.push(`${unresolved.length} nodi rilevanti irrisolti ma HOT emesso`);
      if (blocked.length) violations.push(`${blocked.length} nodi rilevanti TECHNICAL_BLOCKED ma HOT emesso`);
      if (info.agg?.policyFound) violations.push("HOT emesso ma policyFound nel frontier");
    }
  }

  if (String(processingState).startsWith("PUBLISHED")) {
    if (!row.policyFound) violations.push("PUBLISHED senza policyFound");
    if (!String(row.fullEvidence || "").trim()) violations.push("PUBLISHED senza fullEvidence");
    let withPolicy = null;
    for (const fp of frontierPaths) {
      try { const info = await inspectFrontier(fp); if (info.agg?.policyFound) { withPolicy = info; break; } } catch (e) { violations.push(`audit evidence PUB fallito: ${String(e).slice(0,150)}`); }
    }
    if (!withPolicy) violations.push("evidence frontier senza policyFound (first-party mancante)");
    else {
      if (!String(withPolicy.agg.policyText || "").trim()) violations.push("policyText vuoto nel frontier");
      if (!/^[0-9a-f]{64}$/i.test(withPolicy.agg.contentHash || "")) violations.push("hash SHA-256 documento polizza assente nel frontier");
      const policyUrl = withPolicy.agg.policyUrl || "";
      if (!policyUrl) violations.push("policyUrl assente");
      else {
        const siteHost = hostOf(row.website || "");
        const polHost = hostOf(policyUrl);
        if (siteHost && polHost && !sameRegistrable(siteHost, polHost)) violations.push(`policyUrl non first-party: ${polHost} vs sito ufficiale ${siteHost}`);
      }
    }
  }
  return violations;
}

const cp0 = readCp();
if (!cp0) { console.error("checkpoint illeggibile — STOP"); process.exit(2); }
log({ event: "k3_877_start", checkpointPresent: true, terminalBefore: Object.keys(cp0.terminal || {}).length, retryBefore: Object.keys(cp0.retryQueue || {}).length });

const childEnv = {
  ...process.env,
  TOTAL_WORKERS: "1",
  REVALIDATE_CONCURRENCY: "1",
  REVALIDATE_DUAL_HOT: "1",
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

const child = spawn("npx", ["tsx", "scripts/production-revalidate-sanita-v3.mjs"], { cwd: APP, env: childEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });

let stderrTail = "";
child.stderr.on("data", (d) => {
  stderrTail = (stderrTail + d.toString()).slice(-6000);
  process.stderr.write(d);
  if (/OCR_RENDERER_MISSING/.test(stderrTail)) state.stopReasons.push("OCR_RENDERER_MISSING ricomparso");
});

let stopRequested = false;
function killChildTree(sig) { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } }
function requestStop(why) { if (stopRequested) return; stopRequested = true; log({ event: "k3_stop_requested", why }); killChildTree("SIGTERM"); setTimeout(() => killChildTree("SIGKILL"), 120_000).unref(); }

const globalTimer = setTimeout(() => { state.stopReasons.push(`global timeout ${GLOBAL_TIMEOUT_MS}ms`); requestStop("global_timeout"); }, GLOBAL_TIMEOUT_MS);
globalTimer.unref?.();

// Stop file polling (per API/UI)
const stopFileTimer = setInterval(() => { if (fs.existsSync(STOP_FILE)) requestStop("stop_file"); }, 3000);
stopFileTimer.unref?.();

let buf = "";
child.stdout.on("data", (d) => {
  process.stdout.write(d);
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line.startsWith("{")) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    handleEvent(ev).catch((e) => log({ event: "k3_monitor_error", e: String(e).slice(0,200) }));
  }
});

async function handleEvent(ev) {
  state.lastProgressAt = Date.now();
  if (ev.event === "lead_done") {
    state.terminalCount++;
    if (ev.kind === "terminal" || ev.processingState === "HOT_VERIFIED" || String(ev.processingState).startsWith("PUBLISHED")) {
      const violations = await auditTerminal(ev.id, ev.processingState);
      state.audits[ev.id] = { processingState: ev.processingState, violations };
      if (violations.length) state.stopReasons.push(`${ev.id} (${ev.processingState}): ${violations.join("; ")}`);
    }
    writeStatus({ lastLead: ev.id, lastState: ev.processingState });
    if (state.stopReasons.length) requestStop("stop_condition");
  }
  if (ev.event === "metrics") writeStatus({ metrics: ev });
}

// Progress watchdog: se nessun evento per 15 minuti → diagnosi e stop
setInterval(() => {
  if (Date.now() - state.lastProgressAt > 15 * 60_000 && !stopRequested) {
    state.stopReasons.push("watchdog: nessun progresso per 15 minuti");
    requestStop("watchdog_stall");
  }
}, 60_000).unref?.();

const exitCode = await new Promise((resolve) => { child.on("close", (code) => resolve(code ?? -1)); setTimeout(() => resolve(-2), GLOBAL_TIMEOUT_MS + 180_000); });
clearTimeout(globalTimer);
clearInterval(stopFileTimer);
log({ event: "k3_child_exit", exitCode, stopRequested });

const cpF = readCp() || { terminal: {}, retryQueue: {}, stats: {} };
const falseHot = Object.entries(state.audits).filter(([, a]) => a.violations.some((v) => /HOT|frontier|nodi irrisolti/i.test(v))).length;
const falsePub = Object.entries(state.audits).filter(([, a]) => a.violations.some((v) => /PUBLISHED|policy|hash|first-party/i.test(v))).length;
const auditViolations = Object.values(state.audits).reduce((acc, a) => acc + a.violations.length, 0);

writeStatus({
  finishedAt: new Date().toISOString(),
  exitCode,
  stopRequested,
  gate: { falseHot, falsePub, auditViolations, stopReasons: state.stopReasons },
});
log({ event: "k3_877_end", exitCode, stopReasons: state.stopReasons, falseHot, falsePub, auditViolations });
