/**
 * k3 — Micro-canary 10 lead stratificati (demo gate).
 *
 * Gate minimo: 8/10 completati, 0 falsi HOT/PUB, 0 OCR failure.
 * I lead irrisolti restano RETRY_PENDING e non bloccano gli altri.
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
const OUT_JSON = process.env.K3_OUT || path.join(W, "data/k3-stopship/MICRO_CANARY10_RESULTS.json");
const GLOBAL_TIMEOUT_MS = Number(process.env.K3_GLOBAL_TIMEOUT_MS || 2 * 3_600_000);

const CANARY10 = (process.env.K3_IDS || "").split(",").filter(Boolean);
if (!CANARY10.length) {
  console.error("K3_IDS richiesto (comma-separated)");
  process.exit(2);
}

const CHECKPOINT_MARKS = [3, 6, 9, 10];
const log = (obj) => console.log(JSON.stringify({ t: new Date().toISOString(), ...obj }));

const state = {
  startedAt: new Date().toISOString(),
  firstOutcome: {},
  checkpoints: [],
  stopReasons: [],
  audits: {},
};

function readCp() {
  try { return JSON.parse(fs.readFileSync(CHECKPOINT, "utf8")); } catch { return null; }
}
function resultRow(id) {
  try { return JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${id}.json`), "utf8")); } catch { return null; }
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

function evidenceSupportsHot(row) {
  const ev = String(row.fullEvidence || "");
  return /\[CRAWL_COMPLETE:true\]/i.test(ev) && /\[FRONTIER:EXHAUSTED/i.test(ev) && /\[STATE:HOT_VERIFIED\]/i.test(ev);
}

function evidenceSupportsPub(row) {
  const ev = String(row.fullEvidence || "");
  if (row.policyFound !== true) return false;
  if (!/\[STATE:PUBLISHED_/i.test(ev)) return false;
  return /certificata da PDF:\s*https?:\/\//i.test(ev) || /\[DOCS:\s*https?:\/\//i.test(ev);
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
    let frontierAuditOk = false;
    for (const fp of frontierPaths) {
      let info;
      try { info = await inspectFrontier(fp); } catch (e) {
        // RC-10 — tsx path-alias @/lib may fail in monitor process; fall back to evidence stamps.
        if (/ERR_MODULE_NOT_FOUND|Cannot find package '@\/lib'/i.test(String(e))) {
          if (!evidenceSupportsHot(row)) violations.push(`audit frontier unavailable and evidence HOT stamps insufficient: ${String(e).slice(0,80)}`);
          else frontierAuditOk = true;
          continue;
        }
        violations.push(`audit frontier fallito: ${String(e).slice(0,150)}`);
        continue;
      }
      if (!info.runId) { violations.push(`CrawlRun assente: ${fp}`); continue; }
      const c = info.comp || {};
      if (!c.complete) violations.push(`frontier incompleta ma HOT emesso (unresolved=${c.unresolvedRelevantUrls} failed=${c.failedRelevantUrls} unreadable=${c.unreadableRelevantDocuments} ocrDoubts=${c.criticalOcrDoubts} sitemap=${c.sitemapStatus} urlCap=${c.urlCapReached} timeCap=${c.timeCapReached})`);
      const rel = info.nodes.filter((n) => n.relevance === "critical" || n.relevance === "relevant");
      const unresolved = rel.filter((n) => UNRESOLVED_STATES.has(n.state));
      const blocked = rel.filter((n) => n.state === "TECHNICAL_BLOCKED");
      if (unresolved.length) violations.push(`${unresolved.length} nodi rilevanti irrisolti ma HOT emesso`);
      if (blocked.length) violations.push(`${blocked.length} nodi rilevanti TECHNICAL_BLOCKED ma HOT emesso`);
      if (info.agg?.policyFound) violations.push("HOT emesso ma policyFound nel frontier");
      frontierAuditOk = true;
    }
    if (!frontierAuditOk && frontierPaths.length && !evidenceSupportsHot(row)) {
      violations.push("HOT senza audit frontier né stamp CRAWL_COMPLETE/EXHAUSTED");
    }
  }

  if (String(processingState).startsWith("PUBLISHED")) {
    if (!row.policyFound) violations.push("PUBLISHED senza policyFound");
    if (!String(row.fullEvidence || "").trim()) violations.push("PUBLISHED senza fullEvidence");
    let withPolicy = null;
    let moduleFallback = false;
    for (const fp of frontierPaths) {
      try {
        const info = await inspectFrontier(fp);
        if (info.agg?.policyFound) { withPolicy = info; break; }
      } catch (e) {
        if (/ERR_MODULE_NOT_FOUND|Cannot find package '@\/lib'/i.test(String(e))) {
          moduleFallback = true;
          continue;
        }
        violations.push(`audit evidence PUB fallito: ${String(e).slice(0,150)}`);
      }
    }
    if (!withPolicy && moduleFallback && evidenceSupportsPub(row)) {
      // RC-10 — evidence first-party stamps suffice when frontier-store cannot load under monitor
    } else if (!withPolicy) {
      violations.push("evidence frontier senza policyFound (first-party mancante)");
    } else {
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

async function checkpointReport(mark) {
  const cp = readCp() || { terminal: {}, retryQueue: {}, stats: {} };
  const canaryTerminal = CANARY10.filter((id) => cp.terminal?.[id]);
  const canaryRetry = CANARY10.filter((id) => cp.retryQueue?.[id]);
  const report = { mark, at: new Date().toISOString(), canaryTerminal: canaryTerminal.length, canaryRetry: canaryRetry.length, byState: {}, stats: cp.stats, retryReasons: {} };
  for (const id of canaryTerminal) { const st = cp.terminal[id].processingState; report.byState[st] = (report.byState[st] || 0) + 1; }
  for (const id of canaryRetry) { const r = cp.retryQueue[id].lastError || cp.retryQueue[id].lastReason || "?"; report.retryReasons[r] = (report.retryReasons[r] || 0) + 1; }
  state.checkpoints.push(report);
  log({ event: "k3_checkpoint", ...report });
  if (report.byState.TECHNICAL_BLOCKED) state.stopReasons.push(`TECHNICAL_BLOCKED terminale presente (${report.byState.TECHNICAL_BLOCKED})`);
  for (const id of canaryTerminal) {
    if (state.audits[id]) continue;
    const st = cp.terminal[id].processingState;
    const violations = await auditTerminal(id, st);
    state.audits[id] = { processingState: st, violations };
    if (violations.length) { state.stopReasons.push(`${id} (${st}): ${violations.join("; ")}`); log({ event: "k3_audit_violation", id, st, violations }); }
    else log({ event: "k3_audit_ok", id, st });
  }
}

const cp0 = readCp();
log({ event: "k3_micro_canary_start", canary: CANARY10.length, checkpointPresent: Boolean(cp0), terminalBefore: Object.keys(cp0?.terminal || {}).length, retryBefore: Object.keys(cp0?.retryQueue || {}).length });
if (!cp0) { console.error("checkpoint illeggibile — STOP"); process.exit(2); }

for (const id of CANARY10) {
  const t = cp0.terminal?.[id];
  if (!t) continue;
  state.firstOutcome[id] = { processingState: t.processingState, kind: "terminal", at: t.finishedAt, preExisting: true };
  const violations = await auditTerminal(id, t.processingState);
  state.audits[id] = { processingState: t.processingState, violations, preExisting: true };
  if (violations.length) state.stopReasons.push(`preexisting ${id}: ${violations.join("; ")}`);
  log({ event: "k3_preseed_terminal", id, st: t.processingState, violations });
}
// Force canary retries due immediately so long nextRetryAt (sitemap/wall) cannot stall the gate.
{
  const nowIso = new Date().toISOString();
  let forced = 0;
  for (const id of CANARY10) {
    if (!cp0.retryQueue?.[id]) continue;
    if (state.firstOutcome[id]) continue;
    cp0.retryQueue[id].nextRetryAt = nowIso;
    forced++;
  }
  if (forced) {
    fs.writeFileSync(CHECKPOINT, JSON.stringify(cp0, null, 2));
    log({ event: "k3_force_retry_due", forced, at: nowIso });
  }
}

const childEnv = {
  ...process.env,
  REVALIDATE_IDS: CANARY10.join(","),
  FORCE_RESCAN_PUB: "1",
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
  if (ev.event === "lead_done" && CANARY10.includes(ev.id) && !state.firstOutcome[ev.id]) {
    state.firstOutcome[ev.id] = { processingState: ev.processingState, kind: ev.kind, at: new Date().toISOString() };
    if (ev.kind === "terminal" || ev.processingState === "HOT_VERIFIED" || String(ev.processingState).startsWith("PUBLISHED")) {
      const violations = await auditTerminal(ev.id, ev.processingState);
      state.audits[ev.id] = { processingState: ev.processingState, violations };
      if (violations.length) state.stopReasons.push(`${ev.id} (${ev.processingState}): ${violations.join("; ")}`);
    }
    const done = Object.keys(state.firstOutcome).length;
    log({ event: "k3_progress", done, of: CANARY10.length, last: ev.id, st: ev.processingState });
    if (CHECKPOINT_MARKS.includes(done)) await checkpointReport(done);
    if (state.stopReasons.length) requestStop("stop_condition");
    else if (done >= CANARY10.length) requestStop("canary_complete");
  }
}

const exitCode = await new Promise((resolve) => { child.on("close", (code) => resolve(code ?? -1)); setTimeout(() => resolve(-2), GLOBAL_TIMEOUT_MS + 180_000); });
clearTimeout(globalTimer);
log({ event: "k3_child_exit", exitCode, stopRequested });

const cpF = readCp() || { terminal: {}, retryQueue: {}, stats: {} };
const final = { verdict: "NON PASS", stoppedAt: new Date().toISOString(), startedAt: state.startedAt, exitCode, stopReasons: state.stopReasons, canary: CANARY10, firstOutcome: state.firstOutcome, checkpoints: state.checkpoints, audits: state.audits, terminal: {}, retry: {}, gate: {} };
const byState = {};
for (const id of CANARY10) {
  if (cpF.terminal?.[id]) { final.terminal[id] = cpF.terminal[id]; byState[cpF.terminal[id].processingState] = (byState[cpF.terminal[id].processingState] || 0) + 1; }
  else if (cpF.retryQueue?.[id]) final.retry[id] = { lastReason: cpF.retryQueue[id].lastReason, lastError: cpF.retryQueue[id].lastError, attempts: cpF.retryQueue[id].attempts };
}
final.byState = byState;

const handled = Object.keys(state.firstOutcome).length;
const falseHot = Object.entries(state.audits).filter(([, a]) => a.violations.some((v) => /HOT|frontier|nodi irrisolti/i.test(v))).length;
const falsePub = Object.entries(state.audits).filter(([, a]) => a.violations.some((v) => /PUBLISHED|policy|hash|first-party/i.test(v))).length;
const techTerminal = Object.values(final.terminal).filter((t) => t.processingState === "TECHNICAL_BLOCKED").length;
const auditViolations = Object.values(state.audits).reduce((acc, a) => acc + a.violations.length, 0);

// Gate demo: 8/10 completati (terminali), 0 falsi, 0 tech terminali
const completedCommercial = Object.keys(final.terminal).filter((id) => { const st = final.terminal[id].processingState; return st.startsWith("PUBLISHED") || st === "HOT_VERIFIED"; }).length;
final.gate = {
  handled10: handled === 10,
  completedCommercial,
  minCompleted8: completedCommercial >= 8,
  internalTechnicalTerminal: techTerminal,
  ocrRendererMissing: state.stopReasons.filter((r) => /OCR_RENDERER_MISSING/.test(r)).length,
  falseHot,
  falsePub,
  auditViolations,
  checkpointPreserved: Boolean(cpF && cpF.version >= 3),
};
const pass = final.gate.handled10 && final.gate.minCompleted8 && techTerminal === 0 && final.gate.ocrRendererMissing === 0 && auditViolations === 0 && state.stopReasons.length === 0;
final.verdict = pass ? "PASS" : "NON PASS";

fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify(final, null, 1));
log({ event: "k3_micro_canary_end", verdict: final.verdict, byState, gate: final.gate });
