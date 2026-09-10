/**
 * Checkpoint v3 helpers for Sanità revalidation — shared by parent + tests.
 * RETRY_PENDING is never terminal.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** Commercial/semantic terminals only. TECHNICAL_BLOCKED is admin quarantine, not auto-assigned. */
export const TERMINAL_STATES = new Set([
  "HOT_VERIFIED",
  "PUBLISHED_CURRENT",
  "PUBLISHED_EXPIRED",
  "PUBLISHED_DATE_UNKNOWN",
  "SELF_INSURANCE_VERIFIED",
  "OUT_OF_SCOPE",
]);

/** Hard ceiling — exceeded attempts are parked (far nextRetryAt), never auto TECHNICAL_BLOCKED. */
export const MAX_RETRY_ATTEMPTS = Number(process.env.REVALIDATE_MAX_RETRY || 5);
/** Backoff base; sliceContinue still respects backoff (no 5s hot-loop). */
export const RETRY_BASE_MS = Number(process.env.REVALIDATE_RETRY_BASE_MS || 90_000);

export function emptyCheckpointV3(testedCodeSha) {
  return {
    version: 3,
    testedCodeSha,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    terminal: {},
    retryQueue: {},
    inProgress: {},
    attempts: {},
    stats: {
      processed: 0,
      terminal: 0,
      hot: 0,
      pub: 0,
      review: 0,
      retry: 0,
      tech: 0,
      outOfScope: 0,
      errors: 0,
    },
  };
}

export function isTerminalState(processingState) {
  return TERMINAL_STATES.has(processingState);
}

export function isCertifiedHotPass(pass) {
  return Boolean(
    pass &&
      !pass.error &&
      (!pass.token || pass.token === "HOT") &&
      pass.processingState === "HOT_VERIFIED" &&
      pass.crawlComplete === true &&
      pass.policyFound !== true &&
      pass.negativeIdentityCertified === true &&
      pass.siteCoverageCertified === true
  );
}

function isCertifiedPublishedPass(pass) {
  const state = String(pass?.processingState || "");
  return Boolean(
    pass &&
      !pass.error &&
      pass.token === "PUBLISHED" &&
      pass.crawlComplete === true &&
      pass.policyFound === true &&
      (state.startsWith("PUBLISHED") || state === "SELF_INSURANCE_VERIFIED")
  );
}

/**
 * La prova positiva prevale sulla prova di assenza: se uno dei due pass trova
 * una polizza certificata, non può essere ridotto a semplice disagreement.
 * HOT richiede invece due assenze complete e concordi.
 */
export function selectDualOutcome(pass1, pass2) {
  if (isCertifiedPublishedPass(pass2)) {
    return { kind: "published", winner: pass2, source: "p2" };
  }
  if (isCertifiedPublishedPass(pass1)) {
    return { kind: "published", winner: pass1, source: "p1" };
  }
  if (isCertifiedHotPass(pass1) && isCertifiedHotPass(pass2)) {
    return { kind: "hot", winner: pass2, source: "both" };
  }
  // A partial second crawl is not evidence that the two scans disagree.
  // Preserve the p2 frontier and continue it until it is independently
  // complete; only two complete, conflicting outcomes are a disagreement.
  if (
    pass2 &&
    (pass2.error ||
      pass2.processingState === "RETRY_PENDING" ||
      pass2.crawlComplete !== true)
  ) {
    return { kind: "incomplete", winner: pass2, source: "p2" };
  }
  return { kind: "disagree", winner: null, source: null };
}

function hasCertifiedSelfInsuranceEvidence(evidence) {
  const text = String(evidence || "").replace(/\s+/g, " ");
  if (!text) return false;
  const facilityAssertion =
    /(?:la\s+struttura|la\s+societ[aà]|la\s+casa\s+di\s+cura|l['’]istituto|l['’]azienda|l['’]ente).{0,180}(?:assume|adotta|gestisce|opera).{0,180}(?:auto[\s-]?assicuraz|gestione\s+diretta|assunzione\s+diretta)/i.test(
      text
    ) ||
    /assume\s+in\s+proprio.{0,180}(?:sinistri|rischio|auto[\s-]?assicuraz)/i.test(
      text
    );
  if (facilityAssertion) return true;

  // Word boundaries on se/qualora/eventuale: bare "se" falsely matched SELF_*
  // evidence tags (e.g. [SELF_INSURANCE_CITATION:...]) and blocked certified SI.
  const ambiguous =
    /(?:copertura|polizza)\s+assicurativa.{0,120}\b(?:o|oppure|ovvero)\b.{0,100}auto[\s-]?assicuraz|\b(?:se|qualora|eventuale)\b.{0,140}auto[\s-]?assicuraz|periodo\s+in\s+cui.{0,140}auto[\s-]?assicuraz/i.test(
      text
    );
  const normative =
    /delibera|programma\s+regionale|aziende\s+sanitarie\s+sperimentatrici|indicazioni\s+operative|linee\s+guida/i.test(
      text
    );
  if (ambiguous || normative) return false;

  return /opera\s+sotto\s+il\s+regime\s+di\s+auto[\s-]?assicurazione|adotta\s+un\s+sistema\s+di\s+auto[\s-]?assicurazione|(?:è|e)\s+in\s+regime\s+di\s+auto[\s-]?assicurazione|assunzione\s+diretta\s+del\s+rischio|autoritenzione\s+del\s+rischio/i.test(
    text
  );
}

function policyExpiryHasPassed(value, now = new Date()) {
  if (!value) return false;
  const expiry = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  const reference = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (Number.isNaN(expiry.getTime()) || Number.isNaN(reference.getTime())) return false;
  expiry.setUTCHours(23, 59, 59, 999);
  return expiry.getTime() < reference.getTime();
}

function certifiedPublishedState(row, processingState, now) {
  if (policyExpiryHasPassed(row.policyExpiry, now)) return "PUBLISHED_EXPIRED";
  const state = String(processingState || "");
  return TERMINAL_STATES.has(state) && state.startsWith("PUBLISHED")
    ? state
    : "PUBLISHED_DATE_UNKNOWN";
}

function hasOfficialAttributedResource(row, evidence) {
  const attributed =
    row?.entityAttributionCertified === true ||
    /\[ATTR_RESOURCE_ISOLATED:1\]/i.test(evidence);
  const officialIdentity =
    /\[IDENTITY:(?:OFFICIAL_CONFIRMED|GROUP_OFFICIAL_CONFIRMED)\]/i.test(
      evidence
    );
  const exactResource = /\[DOCS:\s*https?:\/\/[^\]\s]+/i.test(evidence);
  return attributed && officialIdentity && exactResource;
}

function hasCertifiedPositivePublication(row, processingState, evidence) {
  const state = String(processingState || "");
  if (
    !state.startsWith("PUBLISHED") ||
    row?.policyFound !== true ||
    row?.error
  ) {
    return false;
  }
  // PUBLISHED_INCOMPLETE means the official first-party publication exists but
  // one commercial detail (usually insurer or expiry) is missing. It is not an
  // uncertain policy match. Require an explicit policy identifier/statement
  // before normalizing it to PUBLISHED_DATE_UNKNOWN.
  if (
    state === "PUBLISHED_INCOMPLETE" &&
    !row?.policyNumber &&
    !/\bpolizza\b.{0,80}(?:n(?:umero|[.°º])?\s*)?[A-Z0-9][A-Z0-9/._-]{4,}/i.test(
      evidence
    )
  ) {
    return false;
  }
  const workerPublished =
    row.token === "PUBLISHED" ||
    row.pass1?.token === "PUBLISHED" ||
    /\[V:PUB\]/i.test(evidence);
  return hasOfficialAttributedResource(row, evidence) && workerPublished;
}

/**
 * Same early-terminal contract as PUBLISHED: an isolated first-party SI proof
 * must close even if unrelated frontier pages remain open. Without this, a
 * worker SELF_INSURANCE_VERIFIED with ATTR/IDENTITY/DOCS stays forever in
 * RETRY_PENDING because crawlComplete is still false (Clinica Sant'Anna).
 */
function hasCertifiedPositiveSelfInsurance(row, processingState, evidence) {
  const state = String(processingState || "");
  if (
    state !== "SELF_INSURANCE_VERIFIED" ||
    row?.policyFound !== true ||
    row?.error
  ) {
    return false;
  }
  if (!hasOfficialAttributedResource(row, evidence)) return false;
  return (
    hasCertifiedSelfInsuranceEvidence(evidence) ||
    /(?:gestione|trattazione).{0,100}(?:sinistri|rischio).{0,200}auto[\s-]?assicuraz|(?:sinistri|rischio).{0,160}(?:gestiti|trattati|operati)?.{0,80}auto[\s-]?assicuraz/i.test(
      evidence
    )
  );
}

export function alignCertifiedTerminalResult(row, state, now = new Date().toISOString()) {
  if (!row || typeof row !== "object") return { changed: false, row };
  const publishedState = String(state).startsWith("PUBLISHED");
  const evidenceBlob = `${row.fullEvidence || ""} ${row.evidence || ""}`;
  const publishedMetadataMismatch =
    publishedState &&
    (row.businessVerdict !== state ||
      row.publishedSubtype !== state ||
      (/\[BV:PUBLISHED_[A-Z_]+\]/i.test(evidenceBlob) &&
        !new RegExp(`\\[BV:${state}\\]`, "i").test(evidenceBlob)));
  const changed = row.processingState !== state || publishedMetadataMismatch;
  if (!changed) return { changed: false, row };

  const rewriteTerminalToken = (value) =>
    typeof value === "string"
      ? value
          .replace(/\[STATE:PUBLISHED_[A-Z_]+\]/gi, `[STATE:${state}]`)
          .replace(/\[PS:PUBLISHED_[A-Z_]+\]/gi, `[PS:${state}]`)
          .replace(/\[BV:PUBLISHED_[A-Z_]+\]/gi, `[BV:${state}]`)
      : value;
  return {
    changed: true,
    row: {
      ...row,
      previousProcessingState: row.processingState || null,
      previousReasonCode: row.reasonCode || null,
      processingState: state,
      businessVerdict: publishedState ? state : row.businessVerdict,
      newVerdict: publishedState ? "PUBLISHED" : row.newVerdict,
      reasonCode: state,
      publishedSubtype: publishedState ? state : row.publishedSubtype,
      fullEvidence: rewriteTerminalToken(row.fullEvidence),
      evidence: rewriteTerminalToken(row.evidence),
      normalizedTerminalAt: now,
    },
  };
}

export function classifyResult(row, opts = {}) {
  const ps = row.processingState || row.reasonCode || null;
  const errBlob = `${row.error || ""} ${row.reasonCode || ""} ${ps || ""}`;
  const evidence = String(row.fullEvidence || row.evidence || "");
  const incomplete =
    row.crawlComplete !== true ||
    /\[FRONTIER:OPEN/i.test(evidence) ||
    /CRAWL_COMPLETE:false/i.test(evidence);

  // Scope is decided before crawling and therefore does not require crawlComplete.
  if (ps === "OUT_OF_SCOPE") {
    return { kind: "terminal", state: "OUT_OF_SCOPE" };
  }

  // Only durable DNS/host-dead proof may terminate without a complete crawl.
  // TLS/refused/timeout/browser failures remain retryable because they can recover.
  if (
    /DNS_NXDOMAIN|ENOTFOUND|ERR_NAME_NOT_RESOLVED|HOST_UNREACHABLE_CONFIRMED/i.test(
      errBlob
    )
  ) {
    return { kind: "terminal", state: "TECHNICAL_BLOCKED" };
  }

  // A positive publication is decided by the isolated fetched resource, not
  // by proof that every other page is absent. This early terminal is allowed
  // only with all independent positive gates: worker PUBLISHED, official
  // identity, exact resource URL and certified entity attribution.
  if (hasCertifiedPositivePublication(row, ps, evidence)) {
    const state = certifiedPublishedState(row, ps, opts.now ?? new Date());
    if (TERMINAL_STATES.has(state)) {
      return { kind: "terminal", state };
    }
  }

  // Same contract for certified self-insurance: do not keep RETRY_PENDING only
  // because SITE_COVERAGE_V3 is still open on unrelated pages.
  if (hasCertifiedPositiveSelfInsurance(row, ps, evidence)) {
    return { kind: "terminal", state: "SELF_INSURANCE_VERIFIED" };
  }

  // Incomplete absence proof is NEVER a commercial terminal. HOT keeps the
  // exhaustive-site and dual-pass requirements unchanged.
  if (incomplete) {
    return { kind: "retry", state: "RETRY_PENDING" };
  }

  // REVIEW is never a commercial terminal: disagreement/identity/partial evidence
  // must be resolved by another pass, not hidden in a permanent manual bucket.
  if (row.dualDisagreement || ps === "REVIEW_HUMAN" || row.newVerdict === "REVIEW") {
    return { kind: "retry", state: "RETRY_PENDING" };
  }

  if (ps === "HOT_VERIFIED" || row.newVerdict === "HOT") {
    const blockedHotEvidence =
      /HOT bloccato|pagine insufficienti|CRAWL_COMPLETE:false|\[FRONTIER:OPEN|PDF non processati/i.test(
        evidence
      );
    if (
      blockedHotEvidence ||
      (row.siteCoverageCertified !== true &&
        !/\[SITE_COVERAGE_V3:1\]/i.test(evidence)) ||
      (row.negativeIdentityCertified !== true &&
        !/\[NEGATIVE_IDENTITY_V2:1\]/i.test(evidence)) ||
      !isCertifiedHotPass(row.pass1) ||
      !isCertifiedHotPass(row.pass2)
    ) {
      return { kind: "retry", state: "RETRY_PENDING" };
    }
    return { kind: "terminal", state: "HOT_VERIFIED" };
  }

  if (
    row.newVerdict === "PUBLISHED" ||
    String(ps || "").startsWith("PUBLISHED") ||
    ps === "SELF_INSURANCE_VERIFIED"
  ) {
    if (row.policyFound !== true) {
      return { kind: "retry", state: "RETRY_PENDING" };
    }
    if (
      row.entityAttributionCertified !== true &&
      !/\[ATTR_RESOURCE_ISOLATED:1\]/i.test(evidence)
    ) {
      return { kind: "retry", state: "RETRY_PENDING" };
    }
    if (
      ps === "PUBLISHED_INCOMPLETE" &&
      !hasCertifiedPositivePublication(row, ps, evidence)
    ) {
      return { kind: "retry", state: "RETRY_PENDING" };
    }
    if (ps === "SELF_INSURANCE_VERIFIED") {
      if (!hasCertifiedSelfInsuranceEvidence(evidence)) {
        return { kind: "retry", state: "RETRY_PENDING" };
      }
      return { kind: "terminal", state: "SELF_INSURANCE_VERIFIED" };
    }
    const state = certifiedPublishedState(row, ps, opts.now ?? new Date());
    return TERMINAL_STATES.has(state)
      ? { kind: "terminal", state }
      : { kind: "retry", state: "RETRY_PENDING" };
  }

  if (isTerminalState(ps)) return { kind: "terminal", state: ps };

  return { kind: "retry", state: "RETRY_PENDING" };
}

export function nextRetryAt(attempts, opts = {}) {
  if (opts.immediate) {
    const delayMs =
      opts.delayMs == null ? 5_000 : Math.max(0, Number(opts.delayMs) || 0);
    return new Date(Date.now() + delayMs).toISOString();
  }
  const n = Math.max(0, Number(attempts) || 0);
  // Cap exponential at 20 min.
  const delay = Math.min(20 * 60_000, RETRY_BASE_MS * Math.pow(2, Math.min(n, 4)));
  // Slice continuation still backs off (min 30s) — never 5s hot-loop.
  if (opts.sliceContinue) {
    return new Date(Date.now() + Math.max(30_000, Math.min(delay, 5 * 60_000))).toISOString();
  }
  return new Date(Date.now() + delay).toISOString();
}

export function isFrontierContinuationReason(reason) {
  return /CRAWL_CAP|FRONTIER_INCOMPLETE|PDF_UNPROCESSED|SITEMAP|LEAD_WALL|RUN_WALL|WORKER_SIGTERM|IN_PROGRESS_INTERRUPTED|OCR_/i.test(
    String(reason || "")
  );
}

export function isExplicitFrontierContinuation(entry) {
  const reason = entry.meta?.lastReason || entry.meta?.lastError;
  // A certified positive proof can close from its isolated first-party
  // resource without exhausting unrelated pages. Keep it in the general
  // certification lane even when an old checkpoint marked its frontier as
  // resumable, otherwise a large continuation starves every PUBLISHED/SI row.
  if (/^PUBLISHED_|^SELF_INSURANCE_VERIFIED$/i.test(String(reason || ""))) {
    return false;
  }
  // Identity recovery requires a clean official-site discovery pass. Keeping
  // crawling the mismatched site's frontier only makes the wrong-site corpus
  // larger and can never resolve the attribution conflict.
  if (/IDENTITY_MISMATCH|POLICY_CROSS_DOMAIN|DUAL_HOT_DISAGREE/i.test(String(reason || ""))) {
    return false;
  }
  if (entry.meta?.continuationReady === true) return true;
  if (entry.meta?.continuationReady === false) return false;
  const pending = Number(entry.meta?.frontierSnapshot?.pending);
  return (
    Number.isFinite(pending) &&
    pending > 0 &&
    isFrontierContinuationReason(reason)
  );
}

/**
 * Preserve the two-lane contract across pump iterations. Rebuilding the queue
 * while one continuation is still running used to select another continuation
 * for the newly free worker, silently turning both workers into frontier lanes.
 */
export function selectNextRetryEntry(orderedEntries, activeEntries = []) {
  if (!orderedEntries.length) return null;
  const continuationAlreadyRunning = activeEntries.some(
    isExplicitFrontierContinuation
  );
  if (!continuationAlreadyRunning) return orderedEntries[0];
  return (
    orderedEntries.find((entry) => !isExplicitFrontierContinuation(entry)) ||
    orderedEntries[0]
  );
}

/**
 * Keep a healthy resumable frontier in the active lane until it converges.
 * Previously every partial slice went behind all older due entries.
 */
export function sortDueRetryEntries(entries) {
  return entries.sort((a, b) => {
    const ac = isExplicitFrontierContinuation(a);
    const bc = isExplicitFrontierContinuation(b);
    if (ac !== bc) return ac ? -1 : 1;
    if (ac && bc) {
      const aSecondPass = a.meta?.passLabel === "p2";
      const bSecondPass = b.meta?.passLabel === "p2";
      if (aSecondPass !== bSecondPass) return aSecondPass ? -1 : 1;
    }
    // Only the live continuation lane is ordered by remaining frontier work.
    // Applying this rule to the general lane made pending=0/blocked frontiers
    // outrank untouched leads forever, causing hundreds of identical retries.
    if (ac && bc) {
      const ap = Number(a.meta?.frontierSnapshot?.pending);
      const bp = Number(b.meta?.frontierSnapshot?.pending);
      const aPending = Number.isFinite(ap) ? ap : Number.MAX_SAFE_INTEGER;
      const bPending = Number.isFinite(bp) ? bp : Number.MAX_SAFE_INTEGER;
      if (aPending !== bPending) return aPending - bPending;
    }
    if (!ac && !bc) {
      // Positive historical evidence is the highest-value recall lane. It is
      // never accepted as terminal here: the current worker still has to
      // re-fetch and satisfy every official-resource/identity gate. Limit the
      // boost to the first two attempts: an ambiguous/non-certifiable positive
      // must not monopolize the general lane forever while untouched leads wait.
      const priority = (meta) => {
        const reason = String(meta?.lastReason || meta?.lastError || "");
        const attempts = Number(meta?.attempts || 0);
        const recallBoost = attempts <= 2;
        if (recallBoost && /^PUBLISHED_/i.test(reason)) return 0;
        if (recallBoost && /^SELF_INSURANCE_VERIFIED$/i.test(reason)) return 1;
        if (recallBoost && /^HOT_VERIFIED$/i.test(reason)) return 2;
        if (/RECERTIFICATION_REQUIRED/i.test(reason)) return 3;
        return 4;
      };
      const pa = priority(a.meta);
      const pb = priority(b.meta);
      if (pa !== pb) return pa - pb;
    }
    if (ac && bc) {
      const ar = new Date(a.meta?.lastAttemptAt || 0).getTime();
      const br = new Date(b.meta?.lastAttemptAt || 0).getTime();
      if (ar !== br) return ar - br;
    }
    const aa = Number(a.meta?.attempts || 0);
    const ab = Number(b.meta?.attempts || 0);
    if (aa !== ab) return aa - ab;
    const ar = new Date(a.meta?.lastAttemptAt || 0).getTime();
    const br = new Date(b.meta?.lastAttemptAt || 0).getTime();
    if (ar !== br) return ar - br;
    const ta = new Date(a.meta?.nextRetryAt || 0).getTime();
    const tb = new Date(b.meta?.nextRetryAt || 0).getTime();
    if (ta !== tb) return ta - tb;
    return String(a.id).localeCompare(String(b.id));
  });
}

/**
 * With two workers reserve one lane for a resumable frontier and one for the
 * rest of the archive. This prevents two very large sites from freezing the
 * visible terminal count while preserving every frontier checkpoint.
 */
export function interleaveFrontierAndGeneralEntries(entries) {
  const ordered = sortDueRetryEntries([...entries]);
  const frontiers = ordered.filter(isExplicitFrontierContinuation);
  const general = ordered.filter((entry) => !frontiers.includes(entry));
  const result = [];
  // Convert already accumulated p2 evidence into certified terminals before
  // opening more p1 work. Both passes remain exhaustive and independent.
  if (
    frontiers.length >= 2 &&
    frontiers[0].meta?.passLabel === "p2" &&
    frontiers[1].meta?.passLabel === "p2"
  ) {
    result.push(frontiers.shift(), frontiers.shift());
  }
  while (frontiers.length || general.length) {
    if (frontiers.length) result.push(frontiers.shift());
    if (general.length) result.push(general.shift());
  }
  return result;
}

/**
 * Retry strategy rotation — never identical infinite loops.
 * resume: same frontier (default for CAP/INCOMPLETE/PDF/WALL/SIGTERM)
 * resume_boost: same frontier + higher HTML/PDF budget
 * fresh: new frontier only after repeated identical external blocks
 */
export function pickRetryStrategy(attempts, lastError, lastStrategy) {
  const err = String(lastError || "");
  const n = Math.max(0, Number(attempts) || 0);
  // Identity mismatch may need a clean seed surface — only allowed fresh case.
  if (/IDENTITY/i.test(err)) return "fresh";
  // STOP-SHIP: never wipe frontier for CAP/incomplete — resume (+boost) only.
  if (n <= 1) return "resume";
  if (n >= 2) return "resume_boost";
  return lastStrategy === "resume_boost" ? "resume_boost" : "resume";
}

/**
 * Keep the isolated worker heap below the service cgroup budget.
 * A later max-old-space-size flag wins in Node, so blindly appending 3072
 * silently overrode the 1536 MiB production limit and triggered OOM restarts.
 */
export function buildWorkerNodeOptions(nodeOptions, heapMb = 1536) {
  const normalizedHeapMb = Math.max(512, Math.floor(Number(heapMb) || 1536));
  const withoutHeapLimit = String(nodeOptions || "")
    .replace(/--max-old-space-size(?:=|\s+)\d+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${withoutHeapLimit}${withoutHeapLimit ? " " : ""}--max-old-space-size=${normalizedHeapMb}`;
}

/**
 * Migrate v2 { done } checkpoint → v3 { terminal, retryQueue }.
 * Preserves result files; RETRY_PENDING entries move to retryQueue.
 */
export function migrateCheckpointV2toV3(cp, resultsDir, testedCodeSha) {
  if (cp?.version >= 3 && cp.terminal && cp.retryQueue) {
    cp.testedCodeSha = cp.testedCodeSha || testedCodeSha;
    // Incomplete hand-written / reset checkpoints may omit attempts/stats.
    if (!cp.attempts || typeof cp.attempts !== "object") cp.attempts = {};
    if (!cp.inProgress || typeof cp.inProgress !== "object") cp.inProgress = {};
    if (!cp.stats || typeof cp.stats !== "object") {
      cp.stats = emptyCheckpointV3(cp.testedCodeSha || testedCodeSha || null).stats;
    }
    return { checkpoint: cp, migrated: 0, terminal: Object.keys(cp.terminal).length, retry: Object.keys(cp.retryQueue).length };
  }
  const out = emptyCheckpointV3(testedCodeSha || cp?.testedCodeSha || null);
  out.startedAt = cp?.startedAt || out.startedAt;
  let migrated = 0;
  const done = cp?.done || {};
  for (const [id, meta] of Object.entries(done)) {
    const resultPath = path.join(resultsDir, `${id}.json`);
    let row = null;
    if (fs.existsSync(resultPath)) {
      try {
        row = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      } catch {
        row = null;
      }
    }
    const processingState = row?.processingState || meta?.processingState || meta?.reasonCode || null;
    const synthetic = row || {
      id,
      processingState,
      newVerdict: meta?.newVerdict ?? null,
      reasonCode: meta?.reasonCode,
      dualDisagreement: false,
    };
    const cls = classifyResult(synthetic);
    out.attempts[id] = (out.attempts[id] || 0) + 1;
    if (cls.kind === "terminal") {
      out.terminal[id] = {
        finishedAt: meta?.finishedAt || row?.finishedAt || new Date().toISOString(),
        processingState: cls.state,
        newVerdict: row?.newVerdict ?? meta?.newVerdict ?? null,
        reasonCode: row?.reasonCode || meta?.reasonCode || cls.state,
      };
      bumpStats(out, cls.state);
    } else {
      out.retryQueue[id] = {
        attempts: out.attempts[id],
        lastReason: processingState || "RETRY_PENDING",
        lastError: row?.pass1?.error || row?.reasonCode || null,
        nextRetryAt: new Date(0).toISOString(), // due immediately for the 5 known retries
        lastRunId: row?.pass1?.runId || null,
        frontierPath: row?.pass1?.frontierPath || null,
        firstSeenAt: meta?.finishedAt || row?.finishedAt || new Date().toISOString(),
        lastAttemptAt: meta?.finishedAt || row?.finishedAt || new Date().toISOString(),
      };
      out.stats.retry++;
      migrated++;
    }
    out.stats.processed++;
  }
  out.updatedAt = new Date().toISOString();
  return {
    checkpoint: out,
    migrated,
    terminal: Object.keys(out.terminal).length,
    retry: Object.keys(out.retryQueue).length,
  };
}

function bumpStats(cp, state) {
  cp.stats.terminal++;
  if (state === "HOT_VERIFIED") cp.stats.hot++;
  else if (state === "SELF_INSURANCE_VERIFIED") cp.stats.pub++;
  else if (String(state).startsWith("PUBLISHED")) cp.stats.pub++;
  else if (state === "REVIEW_HUMAN") cp.stats.review++;
  else if (state === "TECHNICAL_BLOCKED") cp.stats.tech++;
  else if (state === "OUT_OF_SCOPE") cp.stats.outOfScope++;
  else cp.stats.review++;
}

export function saveCheckpointAtomic(filePath, cp) {
  cp.updatedAt = new Date().toISOString();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + `.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(cp, null, 2));
  try {
    const fd = fs.openSync(tmp, "r+");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch {
    /* best-effort fsync */
  }
  fs.renameSync(tmp, filePath);
}

export function writeResultAtomic(filePath, row) {
  const body = JSON.stringify(row, null, 2);
  const hash = crypto.createHash("sha256").update(body).digest("hex");
  row.resultHash = hash;
  row.schemaVersion = row.schemaVersion || 3;
  row.generatedAt = row.generatedAt || new Date().toISOString();
  const finalBody = JSON.stringify(row, null, 2);
  // re-hash after hash field (stable for content sans hash: store contentHash separately)
  row.contentHash = crypto.createHash("sha256").update(JSON.stringify({ ...row, resultHash: undefined, contentHash: undefined })).digest("hex");
  const out = JSON.stringify(row, null, 2);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + `.tmp.${process.pid}`;
  fs.writeFileSync(tmp, out);
  try {
    const fd = fs.openSync(tmp, "r+");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch {
    /* ignore */
  }
  fs.renameSync(tmp, filePath);
  return row;
}

/**
 * Re-check terminal rows against the current fail-closed contract.
 * Historical runs may contain HOT without dual proof, incomplete PUBLISHED,
 * or permanent REVIEW rows. They are made non-commercial and resumed in place.
 */
export function reconcileTerminalCertifications(cp, resultsDir) {
  const demoted = [];
  const normalized = [];
  const now = new Date().toISOString();

  for (const [id, meta] of Object.entries(cp.terminal || {})) {
    const resultPath = path.join(resultsDir, `${id}.json`);
    let row = null;
    if (fs.existsSync(resultPath)) {
      try {
        row = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      } catch {
        row = null;
      }
    }
    const synthetic = row || {
      id,
      processingState: meta?.processingState,
      newVerdict: meta?.newVerdict,
      reasonCode: meta?.reasonCode,
    };
    const classification = classifyResult(synthetic);
    if (classification.kind === "terminal") {
      const checkpointStateChanged = meta?.processingState !== classification.state;
      const aligned = row
        ? alignCertifiedTerminalResult(row, classification.state, now)
        : { changed: false, row };
      const resultNeedsNormalization = aligned.changed;
      if (checkpointStateChanged || resultNeedsNormalization) {
        cp.terminal[id] = {
          ...meta,
          processingState: classification.state,
          newVerdict: row?.newVerdict ?? meta?.newVerdict ?? null,
          reasonCode: classification.state,
        };
        if (resultNeedsNormalization) {
          writeResultAtomic(resultPath, aligned.row);
        }
        normalized.push(id);
      }
      continue;
    }

    const previousAttempts = Number(cp.attempts?.[id] || 0);
    const frontierPath =
      row?.frontierPaths?.at?.(-1) ||
      row?.pass2?.frontierPath ||
      row?.pass1?.frontierPath ||
      null;
    const runId =
      row?.runIds?.at?.(-1) ||
      row?.pass2?.runId ||
      row?.pass1?.runId ||
      null;

    delete cp.terminal[id];
    cp.attempts[id] = 0;
    cp.retryQueue[id] = {
      attempts: 0,
      previousAttempts,
      lastReason: "RECERTIFICATION_REQUIRED",
      lastError: `invalid_terminal:${meta?.processingState || row?.processingState || "UNKNOWN"}`,
      nextRetryAt: new Date(0).toISOString(),
      lastRunId: runId,
      frontierPath,
      firstSeenAt: meta?.finishedAt || row?.finishedAt || now,
      lastAttemptAt: now,
      strategy: frontierPath ? "resume_boost" : "resume",
      forceDue: true,
      operational: true,
    };

    if (row) {
      writeResultAtomic(resultPath, {
        ...row,
        previousProcessingState: row.processingState || meta?.processingState || null,
        previousReasonCode: row.reasonCode || meta?.reasonCode || null,
        processingState: "RETRY_PENDING",
        businessVerdict: null,
        validationStatus: "REVALIDATION_PENDING",
        newVerdict: null,
        token: null,
        reasonCode: "RECERTIFICATION_REQUIRED",
        terminal: false,
        recertificationRequiredAt: now,
      });
    }
    demoted.push(id);
  }

  const terminalStates = Object.values(cp.terminal || {}).map((entry) =>
    String(entry?.processingState || "")
  );
  cp.stats.terminal = terminalStates.length;
  cp.stats.hot = terminalStates.filter((state) => state === "HOT_VERIFIED").length;
  cp.stats.pub = terminalStates.filter(
    (state) => state === "SELF_INSURANCE_VERIFIED" || state.startsWith("PUBLISHED")
  ).length;
  cp.stats.review = terminalStates.filter((state) => state === "REVIEW_HUMAN").length;
  cp.stats.tech = terminalStates.filter((state) => state === "TECHNICAL_BLOCKED").length;
  cp.stats.outOfScope = terminalStates.filter((state) => state === "OUT_OF_SCOPE").length;
  cp.updatedAt = now;

  return {
    demoted,
    normalized,
    terminal: Object.keys(cp.terminal || {}).length,
    retry: Object.keys(cp.retryQueue || {}).length,
  };
}

export function resultHasRequiredFields(row) {
  if (!row || typeof row !== "object") return false;
  if (!row.id) return false;
  if (typeof row.fullEvidence !== "string") return false;
  if (!row.processingState) return false;
  if (!row.schemaVersion) return false;
  return true;
}
