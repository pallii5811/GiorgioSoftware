/**
 * k3 — RC-08 retest mirato sui 3 lead Published conosciuti finiti in REVIEW_HUMAN.
 * Forza i lead in retryQueue (senza perdere frontier), avvia v3 solo sui 3, audit.
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
const OUT_JSON = process.env.K3_OUT || path.join(W, "data/k3-stopship/RC08_RETEST_RESULTS.json");
const GLOBAL_TIMEOUT_MS = Number(process.env.K3_GLOBAL_TIMEOUT_MS || 90 * 60_000);

const CANARY = ["cmqkld5rk009b108ekvol7g87", "cmql4qrif000yc9w74e0tmpqt", "cmql4d399000uc9w7yzw2dgac"];
const CHECKPOINT_MARKS = [3];
const log = (obj) => console.log(JSON.stringify({ t: new Date().toISOString(), ...obj }));

function readCp() { try { return JSON.parse(fs.readFileSync(CHECKPOINT, "utf8")); } catch { return null; } }
function writeCp(cp) { const tmp = `${CHECKPOINT}.tmp.${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(cp, null, 1)); fs.renameSync(tmp, CHECKPOINT); }
function resultRow(id) { try { return JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${id}.json`), "utf8")); } catch { return null; } }
function forceRetry(cp, id) {
  if (cp.terminal?.[id]) {
    const t = cp.terminal[id];
    delete cp.terminal[id];
    cp.retryQueue = cp.retryQueue || {};
    cp.retryQueue[id] = {
      lastError: "RC-08 forced retest",
      lastReason: "RC-08 forced retest",
      attempts: (t.attempts || 0) + 1,
      enqueuedAt: new Date().toISOString(),
    };
  }
  return cp;
}

const UNRESOLVED_STATES = new Set(["DISCOVERED","QUEUED","FETCHING","FETCHED","RENDERED","PARSED","RETRY_PENDING"]);
function hostOf(u) { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; } }
function sameRegistrable(a, b) { const reg = (h) => h.split(".").slice(-2).join("."); return reg(a) === reg(b); }

let frontierStoreMod = null;
async function store() { if (!frontierStoreMod) frontierStoreMod = await import("../src/lib/sanita/frontier-store.ts"); return frontierStoreMod; }
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
    const p1 = row.pass1?.processingState; const p2 = row.pass2?.processingState;
    if (p1 !== "HOT_VERIFIED" || p2 !== "HOT_VERIFIED") violations.push(`dual HOT non concorde (p1=${p1} p2=${p2})`);
    if (!frontierPaths.length) violations.push("frontier HOT mancante su disco");
    for (const fp of frontierPaths) {
      let info; try { info = await inspectFrontier(fp); } catch (e) { violations.push(`audit frontier fallito: ${String(e).slice(0,150)}`); continue; }
      if (!info.runId) { violations.push(`CrawlRun assente: ${fp}`); continue; }
      const c = info.comp || {}; if (!c.complete) violations.push(`frontier incompleta ma HOT emesso`);
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
    for (const fp of frontierPaths) { try { const info = await inspectFrontier(fp); if (info.agg?.policyFound) { withPolicy = info; break; } } catch (e) { violations.push(`audit evidence PUB fallito: ${String(e).slice(0,150)}`); } }
    if (!withPolicy) violations.push("evidence frontier senza policyFound (first-party mancante)");
    else {
      if (!String(withPolicy.agg.policyText || "").trim()) violations.push("policyText vuoto nel frontier");
      if (!/^[0-9a-f]{64}$/i.test(withPolicy.agg.contentHash || "")) violations.push("hash SHA-256 documento polizza assente nel frontier");
      const policyUrl = withPolicy.agg.policyUrl || "";
      if (!policyUrl) violations.push("policyUrl assente");
      else { const siteHost = hostOf(row.website || ""); const polHost = hostOf(policyUrl); if (siteHost && polHost && !sameRegistrable(siteHost, polHost)) violations.push(`policyUrl non first-party: ${polHost} vs sito ufficiale ${siteHost}`); }
    }
  }
  return violations;
}

async function checkpointReport(mark) {
  const cp = readCp() || { terminal: {}, retryQueue: {}, stats: {} };
  const canaryTerminal = CANARY.filter((id) => cp.terminal?.[id]);
  const canaryRetry = CANARY.filter((id) => cp.retryQueue?.[id]);
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

const state = { startedAt: new Date().toISOString(), firstOutcome: {}, checkpoints: [], stopReasons: [], audits: {} };

let cp = readCp();
if (!cp) { console.error("checkpoint illeggibile — STOP"); process.exit(2); }
for (const id of CANARY) cp = forceRetry(cp, id);
writeCp(cp);
log({ event: "k3_rc08_retest_start", canary: CANARY.length, forcedRetry: true, checkpointSha: "present", terminalBefore: Object.keys(readCp().terminal || {}).length, retryBefore: Object.keys(readCp().retryQueue || {}).length });

for (const id of CANARY) {
  const t = cp.terminal?.[id];
  if (!t) continue;
  state.firstOutcome[id] = { processingState: t.processingState, kind: "terminal", at: t.finishedAt, preExisting: true };
  const violations = await auditTerminal(id, t.processingState);
  state.audits[id] = { processingState: t.processingState, violations, preExisting: true };
  if (violations.length) state.stopReasons.push(`preexisting ${id}: ${violations.join("; ")}`);
}

const childEnv = {
  ...process.env,
  REVALIDATE_IDS: CANARY.join(","),
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
child.stderr.on("data", (d) => { stderrTail = (stderrTail + d.toString()).slice(-6000); process.stderr.write(d); if (/OCR_RENDERER_MISSING/.test(stderrTail)) state.stopReasons.push("OCR_RENDERER_MISSING ricomparso"); });
let stopRequested = false;
function killChildTree(sig) { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } }
function requestStop(why) { if (stopRequested) return; stopRequested = true; log({ event: "k3_stop_requested", why }); killChildTree("SIGTERM"); setTimeout(() => killChildTree("SIGKILL"), 120_000).unref(); }
const globalTimer = setTimeout(() => { state.stopReasons.push(`global timeout ${GLOBAL_TIMEOUT_MS}ms`); requestStop("global_timeout"); }, GLOBAL_TIMEOUT_MS); globalTimer.unref?.();

let buf = "";
child.stdout.on("data", (d) => {
  process.stdout.write(d); buf += d.toString(); let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
    if (!line.startsWith("{")) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    handleEvent(ev).catch((e) => log({ event: "k3_monitor_error", e: String(e).slice(0,200) }));
  }
});

async function handleEvent(ev) {
  if (ev.event === "lead_done" && CANARY.includes(ev.id) && !state.firstOutcome[ev.id]) {
    state.firstOutcome[ev.id] = { processingState: ev.processingState, kind: ev.kind, at: new Date().toISOString() };
    if (ev.kind === "terminal" || ev.processingState === "HOT_VERIFIED" || String(ev.processingState).startsWith("PUBLISHED")) {
      const violations = await auditTerminal(ev.id, ev.processingState);
      state.audits[ev.id] = { processingState: ev.processingState, violations };
      if (violations.length) state.stopReasons.push(`${ev.id} (${ev.processingState}): ${violations.join("; ")}`);
    }
    const done = Object.keys(state.firstOutcome).length;
    log({ event: "k3_progress", done, of: CANARY.length, last: ev.id, st: ev.processingState });
    if (CHECKPOINT_MARKS.includes(done)) await checkpointReport(done);
    if (state.stopReasons.length) requestStop("stop_condition");
    else if (done >= CANARY.length) requestStop("canary_complete");
  }
}

const exitCode = await new Promise((resolve) => { child.on("close", (code) => resolve(code ?? -1)); setTimeout(() => resolve(-2), GLOBAL_TIMEOUT_MS + 180_000); });
clearTimeout(globalTimer);
log({ event: "k3_child_exit", exitCode, stopRequested });

const cpF = readCp() || { terminal: {}, retryQueue: {}, stats: {} };
const final = { verdict: "NON PASS", stoppedAt: new Date().toISOString(), startedAt: state.startedAt, exitCode, stopReasons: state.stopReasons, canary: CANARY, firstOutcome: state.firstOutcome, checkpoints: state.checkpoints, audits: state.audits, terminal: {}, retry: {}, gate: {} };
const byState = {};
for (const id of CANARY) { if (cpF.terminal?.[id]) { final.terminal[id] = cpF.terminal[id]; byState[cpF.terminal[id].processingState] = (byState[cpF.terminal[id].processingState] || 0) + 1; } else if (cpF.retryQueue?.[id]) final.retry[id] = { lastReason: cpF.retryQueue[id].lastReason, lastError: cpF.retryQueue[id].lastError, attempts: cpF.retryQueue[id].attempts }; }
final.byState = byState;

const handled = Object.keys(state.firstOutcome).length;
const falseHot = Object.entries(state.audits).filter(([, a]) => a.violations.some((v) => /HOT|frontier|nodi irrisolti/i.test(v))).length;
const falsePub = Object.entries(state.audits).filter(([, a]) => a.violations.some((v) => /PUBLISHED|policy|hash|first-party/i.test(v))).length;
const techTerminal = Object.values(final.terminal).filter((t) => t.processingState === "TECHNICAL_BLOCKED").length;
const auditViolations = Object.values(state.audits).reduce((acc, a) => acc + a.violations.length, 0);
const completedCommercial = Object.keys(final.terminal).filter((id) => { const st = final.terminal[id].processingState; return st.startsWith("PUBLISHED") || st === "HOT_VERIFIED"; }).length;
final.gate = { handled3: handled === 3, completedCommercial, internalTechnicalTerminal: techTerminal, ocrRendererMissing: state.stopReasons.filter((r) => /OCR_RENDERER_MISSING/.test(r)).length, falseHot, falsePub, auditViolations, checkpointPreserved: Boolean(cpF && cpF.version >= 3) };
const pass = final.gate.handled3 && completedCommercial === 3 && techTerminal === 0 && final.gate.ocrRendererMissing === 0 && auditViolations === 0 && state.stopReasons.length === 0;
final.verdict = pass ? "PASS" : "NON PASS";

fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify(final, null, 1));
log({ event: "k3_rc08_retest_end", verdict: final.verdict, byState, gate: final.gate });
