/**
 * Persistent CrawlFrontier — SQLite store (shadow / local paths only).
 * Never points at live Hetzner DB; path must be under data/shadow or tmp test dirs.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CrawlCompleteness, SitemapStatus } from "@/lib/evidence/contract";
import { deriveCrawlComplete, sitemapStatusAllowsHot } from "@/lib/evidence/contract";

export type CrawlRunState =
  | "CREATED"
  | "RUNNING"
  | "PAUSED"
  | "COMPLETED"
  | "FAILED"
  | "ABORTED";

export type FrontierNodeState =
  | "DISCOVERED"
  | "QUEUED"
  | "FETCHING"
  | "FETCHED"
  | "RENDERED"
  | "PARSED"
  | "EXCLUDED"
  | "RETRY_PENDING"
  | "TECHNICAL_BLOCKED"
  | "COMPLETED";

const ALLOWED_TRANSITIONS: Record<FrontierNodeState, FrontierNodeState[]> = {
  DISCOVERED: ["QUEUED", "EXCLUDED", "RETRY_PENDING"],
  QUEUED: ["FETCHING", "EXCLUDED", "RETRY_PENDING"],
  FETCHING: ["FETCHED", "RETRY_PENDING", "TECHNICAL_BLOCKED", "EXCLUDED"],
  FETCHED: ["RENDERED", "PARSED", "EXCLUDED", "RETRY_PENDING", "TECHNICAL_BLOCKED", "FETCHING"],
  RENDERED: ["PARSED", "RETRY_PENDING"],
  PARSED: ["COMPLETED", "EXCLUDED", "RETRY_PENDING"],
  EXCLUDED: [],
  RETRY_PENDING: ["QUEUED", "FETCHING", "TECHNICAL_BLOCKED", "EXCLUDED"],
  // Infra/OCR fix may reopen blocked nodes on frontier resume.
  // EXTERNAL_HOST_IRRELEVANT (alt-TLD pollution) may drop blocked foreign seeds.
  TECHNICAL_BLOCKED: ["RETRY_PENDING", "QUEUED", "EXCLUDED"],
  COMPLETED: [],
};

export type FrontierStoreOptions = {
  dbPath: string;
};

type FrontierGlobal = {
  db: DatabaseSync | null;
  path: string | null;
};

function gstore(): FrontierGlobal {
  const g = globalThis as unknown as { __leadsniperFrontierStore?: FrontierGlobal };
  if (!g.__leadsniperFrontierStore) {
    g.__leadsniperFrontierStore = { db: null, path: null };
  }
  return g.__leadsniperFrontierStore;
}

function assertSafePath(dbPath: string): string {
  const abs = resolve(dbPath);
  const norm = abs.replace(/\\/g, "/").toLowerCase();
  if (
    norm.includes("/opt/leadsniper/") ||
    norm.includes("168.119.253.47") ||
    norm.includes("167.233.209.13")
  ) {
    throw new Error("frontier store refuses live production paths");
  }
  return abs;
}

export function openFrontierStore(dbPath: string): DatabaseSync {
  const abs = assertSafePath(dbPath);
  const slot = gstore();
  if (slot.db && slot.path === abs) return slot.db;
  if (slot.db) {
    try {
      slot.db.close();
    } catch {
      /* ignore */
    }
  }
  mkdirSync(dirname(abs), { recursive: true });
  const db = new DatabaseSync(abs);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS CrawlRun (
      id TEXT PRIMARY KEY,
      leadId TEXT NOT NULL,
      runId TEXT NOT NULL,
      engineVersion TEXT NOT NULL,
      state TEXT NOT NULL,
      startedAt TEXT NOT NULL,
      heartbeatAt TEXT,
      completedAt TEXT,
      currentCheckpoint TEXT,
      workerLock TEXT,
      totalDiscovered INTEGER NOT NULL DEFAULT 0,
      totalRelevant INTEGER NOT NULL DEFAULT 0,
      totalCompleted INTEGER NOT NULL DEFAULT 0,
      totalPending INTEGER NOT NULL DEFAULT 0,
      totalFailed INTEGER NOT NULL DEFAULT 0,
      totalRetryPending INTEGER NOT NULL DEFAULT 0,
      urlCapReached INTEGER NOT NULL DEFAULT 0,
      timeCapReached INTEGER NOT NULL DEFAULT 0,
      identityVerified INTEGER NOT NULL DEFAULT 0,
      scopeVerified INTEGER NOT NULL DEFAULT 0,
      sitemapStatus TEXT NOT NULL DEFAULT 'NOT_DISCOVERED',
      ocrDoubts INTEGER NOT NULL DEFAULT 0,
      unresolvedPolicyCandidates INTEGER NOT NULL DEFAULT 0,
      stopReason TEXT,
      UNIQUE(runId, leadId)
    );
    CREATE TABLE IF NOT EXISTS CrawlFrontierNode (
      id TEXT PRIMARY KEY,
      crawlRunId TEXT NOT NULL,
      canonicalUrl TEXT NOT NULL,
      parentUrl TEXT,
      discoverySource TEXT,
      resourceType TEXT NOT NULL,
      relevance TEXT NOT NULL,
      state TEXT NOT NULL,
      httpStatus INTEGER,
      contentType TEXT,
      retryCount INTEGER NOT NULL DEFAULT 0,
      nextRetryAt TEXT,
      lastError TEXT,
      contentHash TEXT,
      discoveredAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      completedAt TEXT,
      exclusionReason TEXT,
      UNIQUE(crawlRunId, canonicalUrl),
      FOREIGN KEY(crawlRunId) REFERENCES CrawlRun(id)
    );
    CREATE TABLE IF NOT EXISTS WaterfallStepRecord (
      id TEXT PRIMARY KEY,
      crawlRunId TEXT NOT NULL,
      step TEXT NOT NULL,
      attemptedAt TEXT NOT NULL,
      inputJson TEXT,
      outcome TEXT NOT NULL,
      errorType TEXT,
      durationMs INTEGER NOT NULL,
      evidenceAdded TEXT,
      nextStep TEXT,
      FOREIGN KEY(crawlRunId) REFERENCES CrawlRun(id)
    );
    CREATE INDEX IF NOT EXISTS idx_node_run_state ON CrawlFrontierNode(crawlRunId, state);
    CREATE INDEX IF NOT EXISTS idx_run_retry ON CrawlFrontierNode(nextRetryAt);
    CREATE TABLE IF NOT EXISTS CrawlNodeEvidence (
      id TEXT PRIMARY KEY,
      crawlRunId TEXT NOT NULL,
      nodeId TEXT NOT NULL,
      canonicalUrl TEXT NOT NULL,
      contentHash TEXT NOT NULL,
      resourceType TEXT NOT NULL,
      normalizedText TEXT NOT NULL DEFAULT '',
      policyText TEXT NOT NULL DEFAULT '',
      policyFound INTEGER NOT NULL DEFAULT 0,
      policySignalsJson TEXT,
      extractedEntityJson TEXT,
      ocrStatus TEXT,
      playwrightSource TEXT,
      extractedAt TEXT NOT NULL,
      UNIQUE(crawlRunId, contentHash),
      FOREIGN KEY(crawlRunId) REFERENCES CrawlRun(id)
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_run ON CrawlNodeEvidence(crawlRunId);
  `);
  slot.db = db;
  slot.path = abs;
  return db;
}

export function closeFrontierStore(): void {
  const slot = gstore();
  if (slot.db) {
    try {
      slot.db.close();
    } catch {
      /* ignore */
    }
  }
  slot.db = null;
  slot.path = null;
}

function db(): DatabaseSync {
  const slot = gstore();
  if (!slot.db) throw new Error("frontier store not open — call openFrontierStore first");
  return slot.db;
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createCrawlRun(input: {
  leadId: string;
  runId: string;
  engineVersion?: string;
  workerId?: string;
}): { crawlRunId: string; resumed: boolean } {
  const d = db();
  const existing = d
    .prepare(`SELECT id, state, workerLock FROM CrawlRun WHERE runId = ? AND leadId = ?`)
    .get(input.runId, input.leadId) as
    | { id: string; state: string; workerLock: string | null }
    | undefined;

  if (existing) {
    if (existing.state === "RUNNING" && existing.workerLock && existing.workerLock !== input.workerId) {
      throw new Error(`crawl run locked by worker ${existing.workerLock}`);
    }
    d.prepare(
      `UPDATE CrawlRun SET state = 'RUNNING', heartbeatAt = ?, workerLock = ? WHERE id = ?`
    ).run(new Date().toISOString(), input.workerId ?? null, existing.id);
    return { crawlRunId: existing.id, resumed: true };
  }

  const id = uid("cr");
  const now = new Date().toISOString();
  d.prepare(
    `INSERT INTO CrawlRun (
      id, leadId, runId, engineVersion, state, startedAt, heartbeatAt, workerLock
    ) VALUES (?, ?, ?, ?, 'RUNNING', ?, ?, ?)`
  ).run(
    id,
    input.leadId,
    input.runId,
    input.engineVersion ?? "final-closure-20260719",
    now,
    now,
    input.workerId ?? null
  );
  return { crawlRunId: id, resumed: false };
}

export function heartbeatCrawlRun(crawlRunId: string, checkpoint?: string): void {
  db()
    .prepare(
      `UPDATE CrawlRun SET heartbeatAt = ?, currentCheckpoint = COALESCE(?, currentCheckpoint) WHERE id = ?`
    )
    .run(new Date().toISOString(), checkpoint ?? null, crawlRunId);
}

export function upsertFrontierNode(input: {
  crawlRunId: string;
  canonicalUrl: string;
  parentUrl?: string | null;
  discoverySource?: string;
  resourceType: string;
  relevance: "critical" | "relevant" | "low" | "excluded";
  state?: FrontierNodeState;
}): { id: string; created: boolean } {
  const d = db();
  const url = canonicalizeUrl(input.canonicalUrl);
  const existing = d
    .prepare(`SELECT id, state FROM CrawlFrontierNode WHERE crawlRunId = ? AND canonicalUrl = ?`)
    .get(input.crawlRunId, url) as { id: string; state: string } | undefined;
  const now = new Date().toISOString();
  if (existing) {
    return { id: existing.id, created: false };
  }
  const id = uid("fn");
  d.prepare(
    `INSERT INTO CrawlFrontierNode (
      id, crawlRunId, canonicalUrl, parentUrl, discoverySource, resourceType, relevance,
      state, discoveredAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.crawlRunId,
    url,
    input.parentUrl ?? null,
    input.discoverySource ?? "seed",
    input.resourceType,
    input.relevance,
    input.state ?? "DISCOVERED",
    now,
    now
  );
  refreshRunCounts(input.crawlRunId);
  return { id, created: true };
}

export function transitionFrontierNode(
  nodeId: string,
  to: FrontierNodeState,
  patch?: {
    httpStatus?: number | null;
    contentType?: string | null;
    lastError?: string | null;
    contentHash?: string | null;
    exclusionReason?: string | null;
    nextRetryAt?: string | null;
    bumpRetry?: boolean;
  }
): void {
  const d = db();
  const row = d.prepare(`SELECT state, crawlRunId, retryCount FROM CrawlFrontierNode WHERE id = ?`).get(
    nodeId
  ) as { state: FrontierNodeState; crawlRunId: string; retryCount: number } | undefined;
  if (!row) throw new Error(`frontier node not found: ${nodeId}`);
  const allowed = ALLOWED_TRANSITIONS[row.state] ?? [];
  if (to !== row.state && !allowed.includes(to)) {
    throw new Error(`invalid frontier transition ${row.state} → ${to}`);
  }
  const now = new Date().toISOString();
  const retryCount = patch?.bumpRetry ? row.retryCount + 1 : row.retryCount;
  d.prepare(
    `UPDATE CrawlFrontierNode SET
      state = ?,
      httpStatus = COALESCE(?, httpStatus),
      contentType = COALESCE(?, contentType),
      lastError = COALESCE(?, lastError),
      contentHash = COALESCE(?, contentHash),
      exclusionReason = COALESCE(?, exclusionReason),
      nextRetryAt = COALESCE(?, nextRetryAt),
      retryCount = ?,
      updatedAt = ?,
      completedAt = CASE WHEN ? IN ('COMPLETED','EXCLUDED','TECHNICAL_BLOCKED') THEN ? ELSE completedAt END
    WHERE id = ?`
  ).run(
    to,
    patch?.httpStatus ?? null,
    patch?.contentType ?? null,
    patch?.lastError ?? null,
    patch?.contentHash ?? null,
    patch?.exclusionReason ?? null,
    patch?.nextRetryAt ?? null,
    retryCount,
    now,
    to,
    now,
    nodeId
  );
  refreshRunCounts(row.crawlRunId);
}

export function setCrawlRunFlags(
  crawlRunId: string,
  flags: {
    urlCapReached?: boolean;
    timeCapReached?: boolean;
    identityVerified?: boolean;
    scopeVerified?: boolean;
    sitemapStatus?: SitemapStatus;
    ocrDoubts?: number;
    unresolvedPolicyCandidates?: number;
  }
): void {
  const d = db();
  const cur = d.prepare(`SELECT * FROM CrawlRun WHERE id = ?`).get(crawlRunId) as Record<
    string,
    unknown
  >;
  if (!cur) throw new Error("crawl run missing");
  d.prepare(
    `UPDATE CrawlRun SET
      urlCapReached = ?,
      timeCapReached = ?,
      identityVerified = ?,
      scopeVerified = ?,
      sitemapStatus = ?,
      ocrDoubts = ?,
      unresolvedPolicyCandidates = ?,
      heartbeatAt = ?
    WHERE id = ?`
  ).run(
    (flags.urlCapReached ?? Boolean(cur.urlCapReached)) ? 1 : 0,
    (flags.timeCapReached ?? Boolean(cur.timeCapReached)) ? 1 : 0,
    flags.identityVerified != null ? (flags.identityVerified ? 1 : 0) : Number(cur.identityVerified),
    flags.scopeVerified != null ? (flags.scopeVerified ? 1 : 0) : Number(cur.scopeVerified),
    flags.sitemapStatus ?? String(cur.sitemapStatus),
    flags.ocrDoubts ?? Number(cur.ocrDoubts),
    flags.unresolvedPolicyCandidates ?? Number(cur.unresolvedPolicyCandidates),
    new Date().toISOString(),
    crawlRunId
  );
}

function refreshRunCounts(crawlRunId: string): void {
  const d = db();
  const rows = d
    .prepare(
      `SELECT state, relevance, COUNT(*) as c FROM CrawlFrontierNode WHERE crawlRunId = ? GROUP BY state, relevance`
    )
    .all(crawlRunId) as { state: string; relevance: string; c: number }[];

  let totalDiscovered = 0;
  let totalRelevant = 0;
  let totalCompleted = 0;
  let totalPending = 0;
  let totalFailed = 0;
  let totalRetryPending = 0;

  for (const r of rows) {
    totalDiscovered += r.c;
    const rel = r.relevance === "critical" || r.relevance === "relevant";
    if (rel) totalRelevant += r.c;
    if (r.state === "COMPLETED" || r.state === "EXCLUDED") totalCompleted += r.c;
    if (["DISCOVERED", "QUEUED", "FETCHING", "FETCHED", "RENDERED", "PARSED"].includes(r.state) && rel) {
      totalPending += r.c;
    }
    if (r.state === "TECHNICAL_BLOCKED" && rel) totalFailed += r.c;
    if (r.state === "RETRY_PENDING" && rel) totalRetryPending += r.c;
  }

  d.prepare(
    `UPDATE CrawlRun SET
      totalDiscovered = ?, totalRelevant = ?, totalCompleted = ?,
      totalPending = ?, totalFailed = ?, totalRetryPending = ?, heartbeatAt = ?
    WHERE id = ?`
  ).run(
    totalDiscovered,
    totalRelevant,
    totalCompleted,
    totalPending,
    totalFailed,
    totalRetryPending,
    new Date().toISOString(),
    crawlRunId
  );
}

export function completeCrawlRun(crawlRunId: string, stopReason?: string): void {
  const completeness = deriveCrawlCompleteness(crawlRunId);
  const state = completeness.complete ? "COMPLETED" : "FAILED";
  db()
    .prepare(
      `UPDATE CrawlRun SET state = ?, completedAt = ?, stopReason = ?, workerLock = NULL WHERE id = ?`
    )
    .run(state, new Date().toISOString(), stopReason ?? null, crawlRunId);
}

export function abortCrawlRun(crawlRunId: string, reason: string): void {
  db()
    .prepare(
      `UPDATE CrawlRun SET state = 'ABORTED', completedAt = ?, stopReason = ?, workerLock = NULL WHERE id = ?`
    )
    .run(new Date().toISOString(), reason, crawlRunId);
}

export function releaseWorkerLock(crawlRunId: string): void {
  db().prepare(`UPDATE CrawlRun SET workerLock = NULL, state = CASE WHEN state = 'RUNNING' THEN 'PAUSED' ELSE state END WHERE id = ?`).run(
    crawlRunId
  );
}

export type FrontierNodeRow = {
  id: string;
  canonicalUrl: string;
  state: FrontierNodeState;
  relevance: string;
  resourceType: string;
  retryCount: number;
  nextRetryAt: string | null;
  discoverySource: string | null;
  exclusionReason: string | null;
  lastError: string | null;
  httpStatus: number | null;
};

export function listNodes(crawlRunId: string): FrontierNodeRow[] {
  return db()
    .prepare(
      `SELECT id, canonicalUrl, state, relevance, resourceType, retryCount, nextRetryAt,
              discoverySource, exclusionReason, lastError, httpStatus
       FROM CrawlFrontierNode WHERE crawlRunId = ? ORDER BY discoveredAt`
    )
    .all(crawlRunId) as FrontierNodeRow[];
}

export type TerminalMissingUrlDecision = {
  state: "EXCLUDED" | "RETRY_PENDING";
  reasonCode: string;
};

/** 404/410 on guessed seeds, sitemap, internal links → EXCLUDED (not TECHNICAL_BLOCKED). */
export function classifyTerminalMissingUrl(opts: {
  status: 404 | 410;
  discoverySource: string;
  retryCount: number;
}): TerminalMissingUrlDecision {
  const maxBrief = 1;
  if (opts.retryCount < maxBrief) {
    return { state: "RETRY_PENDING", reasonCode: `HTTP_${opts.status}` };
  }
  const src = opts.discoverySource || "html-link";
  if (src === "seed_guess") {
    return { state: "EXCLUDED", reasonCode: "SEED_NOT_PRESENT" };
  }
  if (/sitemap|robots-sitemap/i.test(src)) {
    return { state: "EXCLUDED", reasonCode: "STALE_SITEMAP_URL" };
  }
  if (src === "historical_doc" || src === "extra") {
    return { state: "EXCLUDED", reasonCode: "HISTORICAL_DOC_MISSING" };
  }
  if (src === "seed") {
    return { state: "EXCLUDED", reasonCode: "SEED_NOT_PRESENT" };
  }
  if (src === "html-link" || src === "bfs" || /playwright/i.test(src)) {
    return { state: "EXCLUDED", reasonCode: "BROKEN_INTERNAL_LINK" };
  }
  return { state: "EXCLUDED", reasonCode: "BROKEN_INTERNAL_LINK" };
}

export function isTechnicalFetchFailure(status: number, error?: string | null): boolean {
  if (status === 403 || status === 429) return true;
  if (status >= 500 && status < 600) return true;
  if (status === 0 && error) {
    return /timeout|dns|tls|certificate|econn|enotfound|waf|bot|blocked|reset/i.test(error);
  }
  return false;
}

const MAX_CORPUS_CHARS = 400_000;

export type PersistedEvidenceAggregate = {
  pagesText: string;
  policyText: string;
  policyUrl: string | null;
  policyFound: boolean;
  contentHash: string | null;
};

export function persistNodeEvidence(input: {
  crawlRunId: string;
  nodeId: string;
  canonicalUrl: string;
  contentHash: string;
  resourceType: string;
  normalizedText: string;
  policyText?: string;
  policyFound?: boolean;
  policySignalsJson?: unknown;
  extractedEntityJson?: unknown;
  ocrStatus?: string | null;
  playwrightSource?: string | null;
}): void {
  const d = db();
  const existing = d
    .prepare(`SELECT id FROM CrawlNodeEvidence WHERE crawlRunId = ? AND contentHash = ?`)
    .get(input.crawlRunId, input.contentHash) as { id: string } | undefined;
  if (existing) {
    // Same PDF bytes reprocessed (e.g. OCR gate fix) — refresh text/ocr, don't keep stale empty evidence.
    d.prepare(
      `UPDATE CrawlNodeEvidence SET
        normalizedText = ?,
        policyText = ?,
        policyFound = ?,
        policySignalsJson = ?,
        extractedEntityJson = ?,
        ocrStatus = COALESCE(?, ocrStatus),
        playwrightSource = COALESCE(?, playwrightSource),
        extractedAt = ?
      WHERE id = ?`
    ).run(
      input.normalizedText.slice(0, 120_000),
      (input.policyText || "").slice(0, 40_000),
      input.policyFound ? 1 : 0,
      input.policySignalsJson != null ? JSON.stringify(input.policySignalsJson) : null,
      input.extractedEntityJson != null ? JSON.stringify(input.extractedEntityJson) : null,
      input.ocrStatus ?? null,
      input.playwrightSource ?? null,
      new Date().toISOString(),
      existing.id
    );
    return;
  }
  d.prepare(
    `INSERT INTO CrawlNodeEvidence (
      id, crawlRunId, nodeId, canonicalUrl, contentHash, resourceType,
      normalizedText, policyText, policyFound, policySignalsJson, extractedEntityJson,
      ocrStatus, playwrightSource, extractedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uid("ev"),
    input.crawlRunId,
    input.nodeId,
    input.canonicalUrl,
    input.contentHash,
    input.resourceType,
    input.normalizedText.slice(0, 120_000),
    (input.policyText || "").slice(0, 40_000),
    input.policyFound ? 1 : 0,
    input.policySignalsJson != null ? JSON.stringify(input.policySignalsJson) : null,
    input.extractedEntityJson != null ? JSON.stringify(input.extractedEntityJson) : null,
    input.ocrStatus ?? null,
    input.playwrightSource ?? null,
    new Date().toISOString()
  );
}

function evidencePriority(url: string, resourceType: string, policyFound: boolean): number {
  if (policyFound) return 0;
  const u = url.toLowerCase();
  if (/trasparen|polizz|assicur|amministraz|gelli|rischio|parm|pars|massimale/i.test(u)) return 1;
  if (resourceType === "pdf") return 2;
  if (u.endsWith("/") || /\/(index\.html?)?$/.test(u)) return 3;
  if (/chi-siamo|contatti|about/i.test(u)) return 4;
  return 5;
}

/** Aggregate bounded corpus from all persisted node evidence (survives slice/resume). */
export function aggregatePersistedEvidence(crawlRunId: string): PersistedEvidenceAggregate {
  const rows = db()
    .prepare(
      `SELECT canonicalUrl, contentHash, resourceType, normalizedText, policyText, policyFound
       FROM CrawlNodeEvidence WHERE crawlRunId = ?`
    )
    .all(crawlRunId) as Array<{
    canonicalUrl: string;
    contentHash: string;
    resourceType: string;
    normalizedText: string;
    policyText: string;
    policyFound: number;
  }>;

  rows.sort((a, b) => {
    const pa = evidencePriority(a.canonicalUrl, a.resourceType, Boolean(a.policyFound));
    const pb = evidencePriority(b.canonicalUrl, b.resourceType, Boolean(b.policyFound));
    return pa - pb;
  });

  let pagesText = "";
  let policyText = "";
  let policyUrl: string | null = null;
  let policyFound = false;
  let contentHash: string | null = null;

  for (const r of rows) {
    const chunk = r.normalizedText?.trim();
    if (chunk) {
      const room = MAX_CORPUS_CHARS - pagesText.length;
      if (room > 0) pagesText = `${pagesText}\n${chunk}`.slice(0, MAX_CORPUS_CHARS);
    }
    if (r.policyFound && r.policyText?.trim()) {
      policyFound = true;
      policyText = r.policyText.slice(0, 40_000);
      policyUrl = r.canonicalUrl;
      contentHash = r.contentHash;
    }
  }

  if (!policyFound) {
    for (const r of rows) {
      const pt = r.policyText?.trim() || r.normalizedText?.trim();
      if (!pt) continue;
      const analysis = /polizz|assicuraz|unipol|massimale|scadenz|rc\b/i.test(pt);
      if (analysis) {
        policyText = pt.slice(0, 40_000);
        policyUrl = r.canonicalUrl;
        contentHash = r.contentHash;
        policyFound = true;
        break;
      }
    }
  }

  return { pagesText: pagesText.trim(), policyText, policyUrl, policyFound, contentHash };
}

export function getCrawlRun(crawlRunId: string): Record<string, unknown> | null {
  return (db().prepare(`SELECT * FROM CrawlRun WHERE id = ?`).get(crawlRunId) as Record<
    string,
    unknown
  >) ?? null;
}

/**
 * Unica fonte di CrawlCompleteness per HOT — derivata dai nodi persistiti.
 * Nessun chiamante può forzare complete=true.
 */
export function deriveCrawlCompleteness(crawlRunId: string): CrawlCompleteness {
  const run = getCrawlRun(crawlRunId);
  if (!run) {
    return deriveCrawlComplete({
      identityVerified: false,
      sitemapStatus: "NOT_DISCOVERED",
      htmlQueueExhausted: false,
      relevantLinksProcessed: false,
      relevantDocumentsProcessed: false,
      jsonEndpointsProcessed: false,
      sameHostScriptsProcessed: false,
      unresolvedRelevantUrls: 1,
      failedRelevantUrls: 0,
      unreadableRelevantDocuments: 0,
      criticalOcrDoubts: 0,
      urlCapReached: false,
      timeCapReached: false,
    });
  }

  const nodes = listNodes(crawlRunId);
  const relevant = nodes.filter((n) => n.relevance === "critical" || n.relevance === "relevant");
  const pendingStates = new Set(["DISCOVERED", "QUEUED", "FETCHING", "FETCHED", "RENDERED", "PARSED"]);
  const unresolvedRelevantUrls = relevant.filter((n) => pendingStates.has(n.state)).length;
  const failedRelevantUrls = relevant.filter((n) => n.state === "TECHNICAL_BLOCKED").length;
  const retryPending = relevant.filter((n) => n.state === "RETRY_PENDING").length;
  const pdfs = relevant.filter((n) => n.resourceType === "pdf");
  const pdfUnresolved = pdfs.filter((n) => n.state !== "COMPLETED" && n.state !== "EXCLUDED").length;

  const htmlDone = relevant
    .filter((n) => n.resourceType === "html")
    .every((n) => n.state === "COMPLETED" || n.state === "EXCLUDED");
  const docsDone = pdfs.every((n) => n.state === "COMPLETED" || n.state === "EXCLUDED");
  const jsonDone = relevant
    .filter((n) => n.resourceType === "json")
    .every((n) => n.state === "COMPLETED" || n.state === "EXCLUDED");
  const scriptsDone = relevant
    .filter((n) => n.resourceType === "script")
    .every((n) => n.state === "COMPLETED" || n.state === "EXCLUDED");

  const sitemapStatus = String(run.sitemapStatus || "NOT_DISCOVERED") as SitemapStatus;
  const identityVerified = Boolean(run.identityVerified) && Boolean(run.scopeVerified);
  const ocrDoubts = Number(run.ocrDoubts || 0);
  const policyCandidates = Number(run.unresolvedPolicyCandidates || 0);

  // complete SOLO via deriveCrawlComplete — mai assegnazione diretta true
  const base = deriveCrawlComplete({
    identityVerified,
    sitemapStatus,
    htmlQueueExhausted: htmlDone && unresolvedRelevantUrls === 0 && retryPending === 0,
    relevantLinksProcessed: unresolvedRelevantUrls === 0 && retryPending === 0,
    relevantDocumentsProcessed: docsDone && pdfUnresolved === 0,
    jsonEndpointsProcessed: jsonDone,
    sameHostScriptsProcessed: scriptsDone,
    unresolvedRelevantUrls: unresolvedRelevantUrls + retryPending,
    failedRelevantUrls,
    unreadableRelevantDocuments: pdfUnresolved > 0 ? pdfUnresolved : 0,
    criticalOcrDoubts: ocrDoubts,
    urlCapReached: Boolean(run.urlCapReached),
    timeCapReached: Boolean(run.timeCapReached),
  });

  // Extra gate: policy candidates + run must be finishable
  if (policyCandidates > 0 || !sitemapStatusAllowsHot(sitemapStatus)) {
    return { ...base, complete: false };
  }
  return base;
}

export function recordWaterfallStep(input: {
  crawlRunId: string;
  step: string;
  input?: unknown;
  outcome: string;
  errorType?: string | null;
  durationMs: number;
  evidenceAdded?: string[];
  nextStep?: string | null;
}): void {
  db()
    .prepare(
      `INSERT INTO WaterfallStepRecord (
        id, crawlRunId, step, attemptedAt, inputJson, outcome, errorType, durationMs, evidenceAdded, nextStep
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      uid("ws"),
      input.crawlRunId,
      input.step,
      new Date().toISOString(),
      JSON.stringify(input.input ?? null),
      input.outcome,
      input.errorType ?? null,
      input.durationMs,
      JSON.stringify(input.evidenceAdded ?? []),
      input.nextStep ?? null
    );
}

export function listWaterfallSteps(crawlRunId: string): Array<{ step: string; outcome: string }> {
  return db()
    .prepare(`SELECT step, outcome FROM WaterfallStepRecord WHERE crawlRunId = ? ORDER BY attemptedAt`)
    .all(crawlRunId) as Array<{ step: string; outcome: string }>;
}

export function nodesDueForRetry(nowIso = new Date().toISOString()): Array<{ id: string; crawlRunId: string }> {
  return db()
    .prepare(
      `SELECT id, crawlRunId FROM CrawlFrontierNode WHERE state = 'RETRY_PENDING' AND nextRetryAt IS NOT NULL AND nextRetryAt <= ?`
    )
    .all(nowIso) as Array<{ id: string; crawlRunId: string }>;
}

export function computeBackoffMs(attempt: number, baseMs = 2000, maxMs = 300_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * exp * 0.2);
  return exp + jitter;
}

export function canonicalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    u.hash = "";
    // Hostname is case-insensitive; path/query MUST keep case (Linux hosts 404 on lowercased PDF paths).
    u.hostname = u.hostname.toLowerCase();
    u.protocol = u.protocol.toLowerCase();
    const path = u.pathname.replace(/\/+$/, "") || "/";
    u.pathname = path;
    return u.toString();
  } catch {
    return raw.trim();
  }
}

export function defaultFrontierDbPath(runId: string): string {
  return resolve(`data/shadow/frontier/${runId}.sqlite`);
}

export function frontierStoreExists(dbPath: string): boolean {
  return existsSync(assertSafePath(dbPath));
}
