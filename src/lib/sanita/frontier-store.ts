/**
 * Persistent CrawlFrontier — SQLite store (shadow / local paths only).
 * Never points at live Hetzner DB; path must be under data/shadow or tmp test dirs.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CrawlCompleteness, SitemapStatus } from "@/lib/evidence/contract";
import { deriveCrawlComplete, sitemapStatusAllowsHot } from "@/lib/evidence/contract";
import {
  isClearlyDecorativeImageUrl,
  isCrawlScopeResource,
  isEmbeddedScriptExpressionArtifactUrl,
  isGeneratedRuntimeRequestUrl,
  isPolicyLikeResourceUrl,
  isRecursiveStaticAssetUrl,
  type SiteResourceType,
} from "@/lib/sanita/site-resource";
import { POLICY_CANDIDATE_DETECTOR_VERSION } from "@/lib/sanita/detector";
import { policyEvidenceRecency } from "@/lib/sanita/policy-version-selection";

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
  EXCLUDED: ["QUEUED"],
  RETRY_PENDING: ["QUEUED", "FETCHING", "TECHNICAL_BLOCKED", "EXCLUDED"],
  // Infra/OCR fix may reopen blocked nodes on frontier resume.
  // EXTERNAL_HOST_IRRELEVANT (alt-TLD pollution) may drop blocked foreign seeds.
  TECHNICAL_BLOCKED: ["RETRY_PENDING", "QUEUED", "EXCLUDED"],
  COMPLETED: ["QUEUED"],
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
      policyCandidate INTEGER NOT NULL DEFAULT 0,
      policySignalsJson TEXT,
      extractedEntityJson TEXT,
      ocrStatus TEXT,
      playwrightSource TEXT,
      extractedAt TEXT NOT NULL,
      UNIQUE(crawlRunId, nodeId, contentHash),
      FOREIGN KEY(crawlRunId) REFERENCES CrawlRun(id)
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_run ON CrawlNodeEvidence(crawlRunId);
  `);
  const evidenceColumns = db
    .prepare(`PRAGMA table_info(CrawlNodeEvidence)`)
    .all() as Array<{ name: string }>;
  if (!evidenceColumns.some((column) => column.name === "policyCandidate")) {
    db.exec(
      `ALTER TABLE CrawlNodeEvidence ADD COLUMN policyCandidate INTEGER NOT NULL DEFAULT 0`
    );
  }
  const evidenceSchema = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'CrawlNodeEvidence'`
    )
    .get() as { sql?: string } | undefined;
  if (
    /UNIQUE\s*\(\s*crawlRunId\s*,\s*contentHash\s*\)/i.test(
      String(evidenceSchema?.sql || "")
    )
  ) {
    // Legacy V1 deduplicated solely by bytes. Identical SPA shells or mirrored
    // documents then left later nodes without their own rendered/current
    // evidence. Migrate losslessly to evidence scoped by node + content hash.
    try {
      db.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
        DROP INDEX IF EXISTS idx_evidence_run;
        CREATE TABLE CrawlNodeEvidenceV2 (
          id TEXT PRIMARY KEY,
          crawlRunId TEXT NOT NULL,
          nodeId TEXT NOT NULL,
          canonicalUrl TEXT NOT NULL,
          contentHash TEXT NOT NULL,
          resourceType TEXT NOT NULL,
          normalizedText TEXT NOT NULL DEFAULT '',
          policyText TEXT NOT NULL DEFAULT '',
          policyFound INTEGER NOT NULL DEFAULT 0,
          policyCandidate INTEGER NOT NULL DEFAULT 0,
          policySignalsJson TEXT,
          extractedEntityJson TEXT,
          ocrStatus TEXT,
          playwrightSource TEXT,
          extractedAt TEXT NOT NULL,
          UNIQUE(crawlRunId, nodeId, contentHash),
          FOREIGN KEY(crawlRunId) REFERENCES CrawlRun(id)
        );
        INSERT INTO CrawlNodeEvidenceV2 (
          id, crawlRunId, nodeId, canonicalUrl, contentHash, resourceType,
          normalizedText, policyText, policyFound, policyCandidate,
          policySignalsJson, extractedEntityJson, ocrStatus, playwrightSource,
          extractedAt
        )
        SELECT
          id, crawlRunId, nodeId, canonicalUrl, contentHash, resourceType,
          normalizedText, policyText, policyFound, policyCandidate,
          policySignalsJson, extractedEntityJson, ocrStatus, playwrightSource,
          extractedAt
        FROM CrawlNodeEvidence;
        DROP TABLE CrawlNodeEvidence;
        ALTER TABLE CrawlNodeEvidenceV2 RENAME TO CrawlNodeEvidence;
        CREATE INDEX idx_evidence_run ON CrawlNodeEvidence(crawlRunId);
        COMMIT;
        PRAGMA foreign_keys = ON;
      `);
    } catch (error) {
      try {
        db.exec(`ROLLBACK; PRAGMA foreign_keys = ON;`);
      } catch {
        /* preserve the original migration error */
      }
      throw error;
    }
  }
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
    resourceType?: string | null;
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
      resourceType = COALESCE(?, resourceType),
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
    patch?.resourceType ?? null,
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
    flags.urlCapReached !== undefined
      ? flags.urlCapReached
        ? 1
        : 0
      : Boolean(cur.urlCapReached)
        ? 1
        : 0,
    flags.timeCapReached !== undefined
      ? flags.timeCapReached
        ? 1
        : 0
      : Boolean(cur.timeCapReached)
        ? 1
        : 0,
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

/**
 * Identity is established from the aggregated site corpus after the final crawl
 * slice. Re-evaluate an otherwise exhausted run only after those flags exist;
 * otherwise strict coverage can permanently record a false FAILED state even
 * though every frontier node has already reached a terminal state.
 */
export function finalizeExhaustedCrawlRunAfterIdentity(
  crawlRunId: string
): CrawlCompleteness {
  const run = getCrawlRun(crawlRunId);
  if (!run) return deriveCrawlCompleteness(crawlRunId);

  const totalDiscovered = Number(run.totalDiscovered ?? 0);
  const totalCompleted = Number(run.totalCompleted ?? 0);
  const totalPending = Number(run.totalPending ?? 0);
  const totalRetryPending = Number(run.totalRetryPending ?? 0);
  const totalFailed = Number(run.totalFailed ?? 0);
  const state = String(run.state ?? "");
  const stopReason = String(run.stopReason ?? "");
  const exhausted =
    totalDiscovered > 0 &&
    totalCompleted >= totalDiscovered &&
    totalPending === 0 &&
    totalRetryPending === 0 &&
    totalFailed === 0 &&
    !run.urlCapReached &&
    !run.timeCapReached;
  const mayFinalize =
    exhausted &&
    (state === "RUNNING" ||
      state === "PAUSED" ||
      (state === "FAILED" && stopReason === "frontier_exhausted"));

  if (!mayFinalize) return deriveCrawlCompleteness(crawlRunId);

  // FAILED may be the premature pre-identity result. Coverage deliberately
  // rejects FAILED runs, so restore the transient state before deriving again.
  db()
    .prepare(
      `UPDATE CrawlRun
          SET state = 'RUNNING', completedAt = NULL, workerLock = NULL
        WHERE id = ?`
    )
    .run(crawlRunId);
  completeCrawlRun(crawlRunId, "frontier_exhausted");
  return deriveCrawlCompleteness(crawlRunId);
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
  parentUrl: string | null;
  state: FrontierNodeState;
  relevance: string;
  resourceType: string;
  contentHash: string | null;
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
      `SELECT id, canonicalUrl, parentUrl, state, relevance, resourceType, contentHash, retryCount, nextRetryAt,
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
  policyCandidate?: boolean;
  policySignalsJson?: unknown;
  extractedEntityJson?: unknown;
  ocrStatus?: string | null;
  playwrightSource?: string | null;
}): void {
  const d = db();
  const existing = d
    .prepare(
      `SELECT id FROM CrawlNodeEvidence
       WHERE crawlRunId = ? AND nodeId = ? AND contentHash = ?`
    )
    .get(input.crawlRunId, input.nodeId, input.contentHash) as
    | { id: string }
    | undefined;
  if (existing) {
    // Same PDF bytes reprocessed (e.g. OCR gate fix) — refresh text/ocr, don't keep stale empty evidence.
    d.prepare(
      `UPDATE CrawlNodeEvidence SET
        normalizedText = ?,
        policyText = ?,
        policyFound = ?,
        policyCandidate = ?,
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
      input.policyCandidate ? 1 : 0,
      input.policySignalsJson != null ? JSON.stringify(input.policySignalsJson) : null,
      input.extractedEntityJson != null ? JSON.stringify(input.extractedEntityJson) : null,
      input.ocrStatus ?? null,
      input.playwrightSource ?? null,
      new Date().toISOString(),
      existing.id
    );
    d.prepare(
      `UPDATE CrawlFrontierNode SET contentHash = ?, updatedAt = ?
       WHERE id = ? AND crawlRunId = ?`
    ).run(input.contentHash, new Date().toISOString(), input.nodeId, input.crawlRunId);
    refreshPolicyCandidateCount(input.crawlRunId);
    return;
  }
  d.prepare(
    `INSERT INTO CrawlNodeEvidence (
      id, crawlRunId, nodeId, canonicalUrl, contentHash, resourceType,
      normalizedText, policyText, policyFound, policyCandidate, policySignalsJson, extractedEntityJson,
      ocrStatus, playwrightSource, extractedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    input.policyCandidate ? 1 : 0,
    input.policySignalsJson != null ? JSON.stringify(input.policySignalsJson) : null,
    input.extractedEntityJson != null ? JSON.stringify(input.extractedEntityJson) : null,
    input.ocrStatus ?? null,
    input.playwrightSource ?? null,
    new Date().toISOString()
  );
  // Evidence is authoritative for the bytes most recently parsed for this
  // node. Keeping the node hash synchronized lets every aggregate ignore
  // historical evidence left by an earlier detector/content version.
  d.prepare(
    `UPDATE CrawlFrontierNode SET contentHash = ?, updatedAt = ?
     WHERE id = ? AND crawlRunId = ?`
  ).run(input.contentHash, new Date().toISOString(), input.nodeId, input.crawlRunId);
  refreshPolicyCandidateCount(input.crawlRunId);
}

function refreshPolicyCandidateCount(crawlRunId: string): number {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS c
       FROM CrawlFrontierNode node
       JOIN CrawlNodeEvidence evidence
         ON evidence.nodeId = node.id
        AND evidence.contentHash = node.contentHash
       WHERE node.crawlRunId = ?
         AND evidence.policyCandidate = 1
         AND evidence.policyFound = 0`
    )
    .get(crawlRunId) as { c: number };
  const count = Number(row?.c || 0);
  db()
    .prepare(
      `UPDATE CrawlRun SET unresolvedPolicyCandidates = ?, heartbeatAt = ? WHERE id = ?`
    )
    .run(count, new Date().toISOString(), crawlRunId);
  return count;
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

function policyEvidenceStrength(row: {
  canonicalUrl: string;
  policyText: string;
  normalizedText: string;
  policySignalsJson: string | null;
}): number {
  let score = 0;
  try {
    const signals = JSON.parse(row.policySignalsJson || "{}") as Record<string, unknown>;
    if (signals.policyNumber) score += 80;
    if (signals.expiry) score += 60;
    if (signals.company) score += 40;
    if (signals.massimale) score += 30;
    if (signals.evidence) score += 20;
  } catch {
    /* legacy evidence without valid JSON is scored from its text */
  }
  const text = `${row.policyText || ""}\n${row.normalizedText || ""}`;
  if (/polizza\s+assicurativa/i.test(text)) score += 35;
  if (/\bRCH\d{9,}\b|polizza\s+n[°º.]?\s*[A-Z0-9]/i.test(text)) score += 45;
  if (/\bscad\.?\s*[:\-]?\s*\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|scadenz/i.test(text)) {
    score += 25;
  }
  if (/amministrazione-trasparente|societa-trasparente|\/trasparen/i.test(row.canonicalUrl)) {
    score += 20;
  }
  if (/\/contatti(?:[/?#]|$)/i.test(row.canonicalUrl)) score -= 20;
  return score;
}

/** Aggregate bounded corpus from all persisted node evidence (survives slice/resume). */
export function aggregatePersistedEvidence(crawlRunId: string): PersistedEvidenceAggregate {
  const rows = db()
    .prepare(
      `SELECT evidence.canonicalUrl, evidence.contentHash, evidence.resourceType,
              evidence.normalizedText, evidence.policyText, evidence.policyFound,
              evidence.policySignalsJson
       FROM CrawlNodeEvidence evidence
       JOIN CrawlFrontierNode node
         ON node.id = evidence.nodeId
        AND node.contentHash = evidence.contentHash
       WHERE evidence.crawlRunId = ?`
    )
    .all(crawlRunId) as Array<{
    canonicalUrl: string;
    contentHash: string;
    resourceType: string;
    normalizedText: string;
    policyText: string;
    policyFound: number;
    policySignalsJson: string | null;
  }>;

  rows.sort((a, b) => {
    const pa = evidencePriority(a.canonicalUrl, a.resourceType, Boolean(a.policyFound));
    const pb = evidencePriority(b.canonicalUrl, b.resourceType, Boolean(b.policyFound));
    if (pa !== pb) return pa - pb;
    if (a.policyFound && b.policyFound) {
      const recency =
        policyEvidenceRecency(b.canonicalUrl, b.policySignalsJson) -
        policyEvidenceRecency(a.canonicalUrl, a.policySignalsJson);
      if (Number.isFinite(recency) && recency !== 0) return recency;
    }
    return policyEvidenceStrength(b) - policyEvidenceStrength(a);
  });

  let pagesText = "";
  let policyText = "";
  let policyUrl: string | null = null;
  let policyFound = false;
  let contentHash: string | null = null;
  const corpusHashes = new Set<string>();

  for (const r of rows) {
    const chunk = r.normalizedText?.trim();
    if (chunk && !corpusHashes.has(r.contentHash)) {
      corpusHashes.add(r.contentHash);
      const room = MAX_CORPUS_CHARS - pagesText.length;
      if (room > 0) pagesText = `${pagesText}\n${chunk}`.slice(0, MAX_CORPUS_CHARS);
    }
    if (!policyFound && r.policyFound && r.policyText?.trim()) {
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

export const EXHAUSTIVE_SITE_COVERAGE_VERSION = "SITE_COVERAGE_V3";

export type ExhaustiveSiteCoverage = {
  ok: boolean;
  version: typeof EXHAUSTIVE_SITE_COVERAGE_VERSION;
  reasons: string[];
  totalNodes: number;
  completedNodes: number;
  missingEvidence: number;
  unrenderedHtml: number;
  unresolvedCandidates: number;
  unsafeExclusions: number;
  technicalFailures: number;
};

function strictSiteCoverageEnabled(): boolean {
  return process.env.CRAWL_REQUIRE_EXHAUSTIVE_SITE === "1";
}

const SAFE_EXCLUSION_RE =
  /^(?:SEED_NOT_PRESENT|STALE_SITEMAP_URL|HISTORICAL_DOC_MISSING|BROKEN_INTERNAL_LINK|EXTERNAL_HOST_IRRELEVANT|BROWSER_INTERNAL_RESOURCE|DYNAMIC_BROWSER_REQUEST|SCRIPT_EXPRESSION_ARTIFACT|RECURSIVE_STATIC_ASSET|STATIC_ASSET_HTML_FALLBACK|URL_TEMPLATE_PLACEHOLDER|NON_RESOURCE_DIRECTORY|LOGOUT|LOGIN|CART|DUPLICATE_PARAMS|INFINITE_CALENDAR|INTERNAL_SEARCH|NON_DOCUMENT_MEDIA|OUT_OF_SCOPE_HOST)$/i;

export function deriveExhaustiveSiteCoverage(
  crawlRunId: string
): ExhaustiveSiteCoverage {
  const run = getCrawlRun(crawlRunId);
  const nodes = run ? listNodes(crawlRunId) : [];
  const evidence = run
    ? (db()
        .prepare(
          `SELECT nodeId, contentHash, resourceType, playwrightSource, ocrStatus,
                  policyCandidate, policyFound
           FROM CrawlNodeEvidence WHERE crawlRunId = ?`
        )
        .all(crawlRunId) as Array<{
        nodeId: string;
        contentHash: string;
        resourceType: string;
        playwrightSource: string | null;
        ocrStatus: string | null;
        policyCandidate: number;
        policyFound: number;
      }>)
    : [];
  const evidenceByNodeHash = new Map(
    evidence.map((row) => [`${row.nodeId}:${row.contentHash}`, row])
  );
  const completed = nodes.filter((node) => node.state === "COMPLETED");
  const contentNodes = completed.filter((node) =>
    /^(?:html|pdf|document|office|image|json|script|style|xml|text)$/i.test(
      node.resourceType
    )
  );
  const missingEvidence = contentNodes.filter(
    (node) =>
      !node.contentHash ||
      !evidenceByNodeHash.has(`${node.id}:${node.contentHash}`)
  ).length;
  const unrenderedHtml =
    process.env.CRAWL_RENDER_EVERY_HTML === "1"
      ? completed.filter((node) => {
          if (node.resourceType !== "html") return false;
          const row = node.contentHash
            ? evidenceByNodeHash.get(`${node.id}:${node.contentHash}`)
            : null;
          return row?.playwrightSource !== "rendered";
        }).length
      : 0;
  const currentEvidence = contentNodes
    .map((node) =>
      node.contentHash
        ? evidenceByNodeHash.get(`${node.id}:${node.contentHash}`)
        : null
    )
    .filter((row): row is (typeof evidence)[number] => Boolean(row));
  const unresolvedCandidates = currentEvidence.filter(
    (row) => row.policyCandidate === 1 && row.policyFound !== 1
  ).length;
  const unsafeExclusions = nodes.filter(
    (node) =>
      node.state === "EXCLUDED" &&
      !SAFE_EXCLUSION_RE.test(String(node.exclusionReason || node.lastError || ""))
  ).length;
  const technicalFailures = nodes.filter(
    (node) => node.state === "TECHNICAL_BLOCKED"
  ).length;
  const openNodes = nodes.filter((node) =>
    [
      "DISCOVERED",
      "QUEUED",
      "FETCHING",
      "FETCHED",
      "RENDERED",
      "PARSED",
      "RETRY_PENDING",
    ].includes(node.state)
  ).length;
  const ocrDoubts = currentEvidence.filter((row) =>
    /OCR_(?:TIMEOUT|EXTRACTION_FAILED|RENDERER_MISSING|LOW_CONFIDENCE)/i.test(
      row.ocrStatus || ""
    )
  ).length;
  const sitemapStatus = String(run?.sitemapStatus || "NOT_DISCOVERED") as SitemapStatus;
  const reasons: string[] = [];
  if (!run) reasons.push("crawl_run_missing");
  if (run && /^(?:FAILED|ABORTED)$/i.test(String(run.state || ""))) {
    reasons.push(`crawl_run_${String(run.state).toLowerCase()}`);
  }
  if (nodes.length === 0) reasons.push("frontier_empty");
  if (!sitemapStatusAllowsHot(sitemapStatus)) {
    reasons.push(`sitemap_${sitemapStatus}`);
  }
  if (openNodes > 0) reasons.push(`open_nodes_${openNodes}`);
  if (technicalFailures > 0) reasons.push(`technical_failures_${technicalFailures}`);
  if (missingEvidence > 0) reasons.push(`missing_evidence_${missingEvidence}`);
  if (unrenderedHtml > 0) reasons.push(`unrendered_html_${unrenderedHtml}`);
  if (unresolvedCandidates > 0) {
    reasons.push(`unresolved_policy_candidates_${unresolvedCandidates}`);
  }
  if (unsafeExclusions > 0) reasons.push(`unsafe_exclusions_${unsafeExclusions}`);
  if (ocrDoubts > 0) reasons.push(`ocr_doubts_${ocrDoubts}`);
  if (Boolean(run?.urlCapReached)) reasons.push("url_cap_reached");
  if (Boolean(run?.timeCapReached)) reasons.push("time_cap_reached");
  if (!Boolean(run?.identityVerified) || !Boolean(run?.scopeVerified)) {
    reasons.push("identity_or_scope_unverified");
  }
  return {
    ok: reasons.length === 0,
    version: EXHAUSTIVE_SITE_COVERAGE_VERSION,
    reasons,
    totalNodes: nodes.length,
    completedNodes: completed.length,
    missingEvidence,
    unrenderedHtml,
    unresolvedCandidates,
    unsafeExclusions,
    technicalFailures,
  };
}

/**
 * Upgrade a legacy frontier in place. HTML completed before V3 is rendered
 * again, missing evidence is regenerated and breadth-cap exclusions reopen.
 */
export function prepareFrontierForExhaustiveCoverage(crawlRunId: string): number {
  // Historical frontiers may have classified extensionless WordPress APIs,
  // SVGs and cursor assets as HTML. Correct the type before deciding which
  // resources require a browser render.
  db()
    .prepare(
      `UPDATE CrawlFrontierNode
       SET resourceType = CASE
         WHEN lower(canonicalUrl) LIKE '%.png%'
           OR lower(canonicalUrl) LIKE '%.jpg%'
           OR lower(canonicalUrl) LIKE '%.jpeg%'
           OR lower(canonicalUrl) LIKE '%.webp%'
           OR lower(canonicalUrl) LIKE '%.gif%'
           OR lower(canonicalUrl) LIKE '%.tif%'
           OR lower(canonicalUrl) LIKE '%.bmp%' THEN 'image'
         WHEN lower(canonicalUrl) LIKE '%.pdf%' THEN 'pdf'
         WHEN lower(canonicalUrl) LIKE '%.doc%'
           OR lower(canonicalUrl) LIKE '%.xls%'
           OR lower(canonicalUrl) LIKE '%.ppt%'
           OR lower(canonicalUrl) LIKE '%.odt%'
           OR lower(canonicalUrl) LIKE '%.ods%'
           OR lower(canonicalUrl) LIKE '%.rtf%' THEN 'office'
         WHEN lower(canonicalUrl) LIKE '%.cur%' THEN 'other'
         WHEN lower(canonicalUrl) LIKE '%.svg%' THEN 'xml'
         WHEN lower(canonicalUrl) LIKE '%/wp-json/%'
           OR lower(canonicalUrl) LIKE '%/wp-json' THEN 'json'
         ELSE resourceType
       END
       WHERE crawlRunId = ?
         AND state NOT IN ('COMPLETED', 'EXCLUDED')`
    )
    .run(crawlRunId);
  const nodes = listNodes(crawlRunId);
  const embeddedArtifactUrls = new Set(
    nodes
      .filter(
        (node) =>
          /^(?:embedded-resource|html-resource-inline)$/i.test(
            String(node.discoverySource || "")
          ) && isEmbeddedScriptExpressionArtifactUrl(node.canonicalUrl)
      )
      .map((node) => node.canonicalUrl)
  );
  // A fake expression route can itself return an HTML shell and generate more
  // fake children. Exclude that entire synthetic branch while retaining every
  // route independently observed through DOM links, sitemaps or the browser.
  let artifactBranchExpanded = true;
  while (artifactBranchExpanded) {
    artifactBranchExpanded = false;
    for (const node of nodes) {
      if (
        node.parentUrl &&
        embeddedArtifactUrls.has(node.parentUrl) &&
        node.canonicalUrl.startsWith(`${node.parentUrl.replace(/\/+$/, "")}/`) &&
        !embeddedArtifactUrls.has(node.canonicalUrl)
      ) {
        embeddedArtifactUrls.add(node.canonicalUrl);
        artifactBranchExpanded = true;
      }
    }
  }
  // Existing checkpoints can contain children generated before the recursive
  // path itself was recognized. Close the full parent chain; independent URLs
  // discovered through DOM/sitemap/browser remain untouched.
  const recursiveAssetUrls = new Set(
    nodes
      .filter((node) => isRecursiveStaticAssetUrl(node.canonicalUrl))
      .map((node) => node.canonicalUrl)
  );
  let recursiveBranchExpanded = true;
  while (recursiveBranchExpanded) {
    recursiveBranchExpanded = false;
    for (const node of nodes) {
      if (
        node.parentUrl &&
        recursiveAssetUrls.has(node.parentUrl) &&
        !recursiveAssetUrls.has(node.canonicalUrl)
      ) {
        recursiveAssetUrls.add(node.canonicalUrl);
        recursiveBranchExpanded = true;
      }
    }
  }
  const evidence = db()
    .prepare(
      `SELECT nodeId, contentHash, playwrightSource, policyCandidate, policyFound,
              policySignalsJson,
              CASE
                WHEN instr(lower(normalizedText), 'polizza') > 0
                  OR instr(lower(normalizedText), 'assicurativ') > 0
                  OR instr(lower(normalizedText), 'responsabilita civile') > 0
                  OR instr(lower(normalizedText), 'responsabilità civile') > 0
                THEN 1 ELSE 0
              END AS policyLikeText
       FROM CrawlNodeEvidence WHERE crawlRunId = ?`
    )
    .all(crawlRunId) as Array<{
    nodeId: string;
    contentHash: string;
    playwrightSource: string | null;
    policyCandidate: number;
    policyFound: number;
    policySignalsJson: string | null;
    policyLikeText: number;
  }>;
  const byNodeHash = new Map(
    evidence.map((row) => [`${row.nodeId}:${row.contentHash}`, row])
  );
  const primaryHost = (() => {
    for (const node of nodes) {
      if (node.resourceType !== "html" || node.relevance !== "critical") continue;
      try {
        return new URL(node.canonicalUrl).hostname
          .replace(/^www\./i, "")
          .toLowerCase();
      } catch {
        /* try the next critical HTML seed */
      }
    }
    return null;
  })();
  let reopened = 0;
  const cachelessStaticSeen = new Set<string>();

  for (const node of nodes) {
    const cachelessStaticUrl = canonicalizeUrl(node.canonicalUrl);
    const hadRemovedCacheBuster = cachelessStaticUrl !== node.canonicalUrl;
    const duplicateCacheBuster =
      hadRemovedCacheBuster && cachelessStaticSeen.has(cachelessStaticUrl);
    if (hadRemovedCacheBuster && !duplicateCacheBuster) {
      cachelessStaticSeen.add(cachelessStaticUrl);
    }
    const browserInternal =
      node.discoverySource === "playwright-network" &&
      (/^https?:\/\/(?:chrome|chrome-extension|devtools)(?:[/:]|$)/i.test(
        node.canonicalUrl
      ) ||
        !/^https?:\/\//i.test(node.canonicalUrl));
    const dynamicBrowserRequest =
      /\/(?:wp-admin\/admin-ajax|xmlrpc|wp-comments-post)\.php(?:$|[?#])/i.test(
        node.canonicalUrl
      ) ||
      /\/wp-content\/plugins\/[^/]+\/(?:booster|ajax)(?:$|[?#])/i.test(
        node.canonicalUrl
      ) ||
      /\/_api\/members\/v1\/privacy-settings(?:$|[?#])/i.test(
        node.canonicalUrl
      ) ||
      /\/_api\/ecommerce-settings\/v1\/ecommerce-settings(?:$|[?#])/i.test(
        node.canonicalUrl
      ) ||
      /\/_partials\/wix-thunderbolt\//i.test(node.canonicalUrl) ||
      /\/_serverless\/collection-settings-facade\/get-settings(?:$|[?#])/i.test(
        node.canonicalUrl
      ) ||
      /\/usm_[\d._]+(?:$|[?#])/i.test(node.canonicalUrl) ||
      isGeneratedRuntimeRequestUrl(node.canonicalUrl) ||
      /^[^?#]+[?]p=\d+$/i.test(node.canonicalUrl);
    const fromEmbeddedSource =
      /^(?:embedded-resource|html-resource-inline)$/i.test(
        String(node.discoverySource || "")
      );
    const scriptExpressionArtifact =
      embeddedArtifactUrls.has(node.canonicalUrl) ||
      (fromEmbeddedSource &&
      (
        /\?\.[A-Za-z_$]/.test(node.canonicalUrl) ||
        /(?:%24%7B|\$\{|%23clip|window\.location|\.baseURI|\.blockedURI|\.documentURI|\.old,|function(?:%28|\()|normalizeUrl(?:%28|\()|(?:substring|substr|slice)(?:%28|\()|(?:%5B|\[)[A-Za-z_$][\w$]*(?:%5D|\])|\+[A-Za-z_$][\w$]*(?:\+|\.|(?:%5B|\[))|,[A-Za-z_$][\w$]*(?:\.|$))/i.test(
          node.canonicalUrl
        )
      ));
    const recursiveStaticAsset = recursiveAssetUrls.has(node.canonicalUrl);
    const urlTemplatePlaceholder =
      /(?:%7B|%7D|\{|\})/i.test(node.canonicalUrl);
    const nonDocumentBinary =
      /\.(?:cur|exe|msi|dll|dmg|apk)(?:$|[?#])/i.test(node.canonicalUrl);
    const clearlyDecorativeImage =
      node.resourceType === "image" &&
      isClearlyDecorativeImageUrl(node.canonicalUrl);
    let internalSearchUrl = false;
    let nonResourceDirectory = false;
    let outOfScopeExternalAsset = false;
    try {
      const parsed = new URL(node.canonicalUrl);
      const pathname = parsed.pathname;
      internalSearchUrl =
        parsed.searchParams.has("s") ||
        parsed.searchParams.has("search") ||
        /\/search(?:\/|$)/i.test(pathname);
      nonResourceDirectory =
        /^\/wp-admin\/?$/i.test(pathname) ||
        /^\/wp-content\/(?:uploads|themes)(?:\/[^.]+)*\/?$/i.test(pathname) ||
        /^\/wp-content\/(?:plugins|themes)\/.+\/(?:assets?|images?|css|js)\/?$/i.test(
          pathname
        );
      const samePrimarySite = Boolean(
        primaryHost &&
          isCrawlScopeResource(
            node.canonicalUrl,
            `https://${primaryHost}/`,
            node.resourceType as SiteResourceType
          )
      );
      const linkedExternalDocument = Boolean(
        primaryHost &&
          /^(?:pdf|office)$/i.test(node.resourceType) &&
          node.parentUrl &&
          (() => {
            try {
              return (
                new URL(node.parentUrl as string).hostname
                  .replace(/^www\./i, "")
                  .toLowerCase() === primaryHost
              );
            } catch {
              return false;
            }
          })() &&
          !/(?:inline|embedded|playwright-network)/i.test(
            String(node.discoverySource || "")
          )
      );
      outOfScopeExternalAsset = Boolean(
        primaryHost &&
          !samePrimarySite &&
          !linkedExternalDocument &&
          !isPolicyLikeResourceUrl(node.canonicalUrl) &&
          (/template-help\.com\/wordpress\/prod_/i.test(node.canonicalUrl) ||
            (/^(?:html|image|script|style|json|xml|text|other)$/i.test(node.resourceType) ||
              /privacy|cookie|terms?(?:[-_/ ]|$)|gdpr|ccpa|legitimate[-_ ]interests?|advertis|buyer[-_ ]addendum|vendor[-_ ]policy/i.test(
                node.canonicalUrl
              )))
      );
    } catch {
      /* invalid URL is handled as browser-internal when applicable */
    }
    const syntheticExclusionReason = browserInternal
      ? "BROWSER_INTERNAL_RESOURCE"
      : dynamicBrowserRequest
        ? "DYNAMIC_BROWSER_REQUEST"
        : duplicateCacheBuster
          ? "DUPLICATE_PARAMS"
          : nonDocumentBinary
            ? "NON_DOCUMENT_MEDIA"
            : clearlyDecorativeImage
              ? "NON_DOCUMENT_MEDIA"
            : recursiveStaticAsset
              ? "RECURSIVE_STATIC_ASSET"
            : scriptExpressionArtifact
              ? "SCRIPT_EXPRESSION_ARTIFACT"
              : urlTemplatePlaceholder
                ? "URL_TEMPLATE_PLACEHOLDER"
                : internalSearchUrl
                  ? "INTERNAL_SEARCH"
                  : nonResourceDirectory
                    ? "NON_RESOURCE_DIRECTORY"
                    : outOfScopeExternalAsset
                      ? "OUT_OF_SCOPE_HOST"
                      : null;
    if (syntheticExclusionReason) {
      try {
        if (node.state === "COMPLETED") {
          transitionFrontierNode(node.id, "QUEUED", {
            lastError: syntheticExclusionReason,
          });
        }
        if (node.state !== "EXCLUDED") {
          transitionFrontierNode(node.id, "EXCLUDED", {
            lastError: syntheticExclusionReason,
            exclusionReason: syntheticExclusionReason,
          });
        }
        reopened++;
      } catch {
        /* coverage remains closed if cleanup cannot transition safely */
      }
      continue;
    }
    const evidenceRow = node.contentHash
      ? byNodeHash.get(`${node.id}:${node.contentHash}`)
      : null;
    const needsRenderedHtml =
      node.state === "COMPLETED" &&
      node.resourceType === "html" &&
      evidenceRow?.playwrightSource !== "rendered";
    const needsEvidence =
      node.state === "COMPLETED" &&
      /^(?:html|pdf|document|office|image|json|script|style|xml|text)$/i.test(
        node.resourceType
      ) &&
      !evidenceRow;
    const needsCandidateReanalysis =
      node.state === "COMPLETED" &&
      Boolean(evidenceRow) &&
      (evidenceRow?.policyCandidate === 1 ||
        evidenceRow?.policyFound === 1 ||
        evidenceRow?.policyLikeText === 1 ||
        /polizz|assicur|copertura|responsabilit|gelli|trasparen/i.test(node.canonicalUrl)) &&
      !String(evidenceRow?.policySignalsJson || "").includes(
        `"candidateDetectorVersion":"${POLICY_CANDIDATE_DETECTOR_VERSION}"`
      );
    const unsafeLegacyExclusion =
      node.state === "EXCLUDED" &&
      !SAFE_EXCLUSION_RE.test(String(node.exclusionReason || node.lastError || ""));
    if (
      !needsRenderedHtml &&
      !needsEvidence &&
      !needsCandidateReanalysis &&
      !unsafeLegacyExclusion
    ) {
      continue;
    }
    try {
      transitionFrontierNode(node.id, "QUEUED", {
        lastError: unsafeLegacyExclusion
          ? "EXHAUSTIVE_REOPEN_UNSAFE_EXCLUSION"
          : "EXHAUSTIVE_RECERTIFICATION",
      });
      reopened++;
    } catch {
      /* fail-closed: the coverage proof remains false */
    }
  }
  return reopened;
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
  const strict = strictSiteCoverageEnabled();
  const relevant = strict
    ? nodes.filter((n) => n.relevance !== "excluded")
    : nodes.filter((n) => n.relevance === "critical" || n.relevance === "relevant");
  const pendingStates = new Set(["DISCOVERED", "QUEUED", "FETCHING", "FETCHED", "RENDERED", "PARSED"]);
  const unresolvedRelevantUrls = relevant.filter((n) => pendingStates.has(n.state)).length;
  let failedRelevantUrls = relevant.filter((n) => n.state === "TECHNICAL_BLOCKED").length;
  const retryPending = relevant.filter((n) => n.state === "RETRY_PENDING").length;
  const pdfs = relevant.filter((n) =>
    strict
      ? /^(?:pdf|document|office|image)$/i.test(n.resourceType)
      : n.resourceType === "pdf"
  );
  const pdfUnresolved = pdfs.filter((n) => n.state !== "COMPLETED" && n.state !== "EXCLUDED").length;

  const htmlDone = relevant
    .filter((n) => n.resourceType === "html")
    .every((n) => n.state === "COMPLETED" || n.state === "EXCLUDED");
  const docsDone = pdfs.every((n) => n.state === "COMPLETED" || n.state === "EXCLUDED");
  const jsonDone = relevant
    .filter((n) => n.resourceType === "json")
    .every((n) => n.state === "COMPLETED" || n.state === "EXCLUDED");
  const scriptsDone = relevant
    .filter((n) => n.resourceType === "script" || (strict && n.resourceType === "style"))
    .every((n) => n.state === "COMPLETED" || n.state === "EXCLUDED");

  const sitemapStatus = String(run.sitemapStatus || "NOT_DISCOVERED") as SitemapStatus;
  const identityVerified = Boolean(run.identityVerified) && Boolean(run.scopeVerified);
  let ocrDoubts = Number(run.ocrDoubts || 0);
  let policyCandidates = Number(run.unresolvedPolicyCandidates || 0);
  let strictCoverage: ExhaustiveSiteCoverage | null = null;
  if (strict) {
    strictCoverage = deriveExhaustiveSiteCoverage(crawlRunId);
    failedRelevantUrls +=
      strictCoverage.technicalFailures +
      strictCoverage.unsafeExclusions +
      strictCoverage.missingEvidence +
      strictCoverage.unrenderedHtml;
    policyCandidates = strictCoverage.unresolvedCandidates;
    if (strictCoverage.reasons.some((reason) => reason.startsWith("ocr_doubts_"))) {
      ocrDoubts++;
    }
  }

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
  if (
    policyCandidates > 0 ||
    !sitemapStatusAllowsHot(sitemapStatus) ||
    (strictCoverage && !strictCoverage.ok)
  ) {
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

/** Invariant: RETRY_PENDING must always carry nextRetryAt. */
export function countRetryPendingMissingNextRetryAt(crawlRunId?: string): number {
  const d = db();
  if (crawlRunId) {
    const row = d
      .prepare(
        `SELECT count(*) as c FROM CrawlFrontierNode
         WHERE crawlRunId = ? AND state = 'RETRY_PENDING'
           AND (nextRetryAt IS NULL OR nextRetryAt = '')`
      )
      .get(crawlRunId) as { c: number };
    return Number(row?.c || 0);
  }
  const row = d
    .prepare(
      `SELECT count(*) as c FROM CrawlFrontierNode
       WHERE state = 'RETRY_PENDING' AND (nextRetryAt IS NULL OR nextRetryAt = '')`
    )
    .get() as { c: number };
  return Number(row?.c || 0);
}

/** Assign controlled nextRetryAt to orphan RETRY_PENDING nodes (preserves run/frontier). */
export function repairOrphanRetryPending(crawlRunId: string): number {
  const orphans = listNodes(crawlRunId).filter(
    (n) => n.state === "RETRY_PENDING" && (!n.nextRetryAt || n.nextRetryAt === "")
  );
  let n = 0;
  for (const node of orphans) {
    try {
      transitionFrontierNode(node.id, "RETRY_PENDING", {
        nextRetryAt: new Date(
          Date.now() + computeBackoffMs((node.retryCount || 0) + 1)
        ).toISOString(),
        lastError: node.lastError || "repaired_null_nextRetryAt",
      });
      n++;
    } catch {
      /* */
    }
  }
  return n;
}

/**
 * Demote html-link/sitemap/playwright (and legacy unmarked) nodes wrongly stored
 * as critical/relevant under the old "every HTML is relevant" classifier —
 * prevents fake CRAWL_CAP / FRONTIER_INCOMPLETE storms.
 * Seeds (seed|seed_guess|extra) keep their relevance.
 */
export function reclassifySpuriousRelevance(
  crawlRunId: string,
  classify: (url: string, opts?: { discoverySource?: string | null }) => "critical" | "relevant" | "low"
): number {
  const d = db();
  let n = 0;
  for (const node of listNodes(crawlRunId)) {
    const src = String(node.discoverySource || "");
    if (src === "seed" || src === "seed_guess" || src === "extra") continue;
    if (node.relevance !== "critical" && node.relevance !== "relevant") continue;
    // Prefer stored discoverySource; unknown/legacy → treat as html-link for classify.
    const classifySrc = src || "html-link";
    const next = classify(node.canonicalUrl, { discoverySource: classifySrc });
    if (next === node.relevance) continue;
    if (next !== "low") continue;
    d.prepare(`UPDATE CrawlFrontierNode SET relevance = ?, updatedAt = ? WHERE id = ?`).run(
      next,
      new Date().toISOString(),
      node.id
    );
    n++;
  }
  if (n) refreshRunCounts(crawlRunId);
  return n;
}

export function frontierDiagnosticSummary(crawlRunId: string): {
  byState: Record<string, number>;
  byRelevance: Record<string, number>;
  pdfFound: number;
  pdfCompleted: number;
  unresolvedCriticalRelevant: number;
  nullRetryNextAt: number;
  sitemapStatus: string | null;
  urlCapReached: boolean;
  timeCapReached: boolean;
  runState: string | null;
  heartbeat: string | null;
} {
  const nodes = listNodes(crawlRunId);
  const byState: Record<string, number> = {};
  const byRelevance: Record<string, number> = {};
  for (const n of nodes) {
    byState[n.state] = (byState[n.state] || 0) + 1;
    byRelevance[n.relevance] = (byRelevance[n.relevance] || 0) + 1;
  }
  const pdfs = nodes.filter((n) => n.resourceType === "pdf" || /\.pdf/i.test(n.canonicalUrl));
  const pending = new Set(["DISCOVERED", "QUEUED", "FETCHING", "FETCHED", "RENDERED", "PARSED", "RETRY_PENDING"]);
  const unresolvedCriticalRelevant = nodes.filter(
    (n) => (n.relevance === "critical" || n.relevance === "relevant") && pending.has(n.state)
  ).length;
  const run = getCrawlRun(crawlRunId);
  return {
    byState,
    byRelevance,
    pdfFound: pdfs.length,
    pdfCompleted: pdfs.filter((n) => n.state === "COMPLETED").length,
    unresolvedCriticalRelevant,
    nullRetryNextAt: nodes.filter((n) => n.state === "RETRY_PENDING" && !n.nextRetryAt).length,
    sitemapStatus: run ? String(run.sitemapStatus || "") : null,
    urlCapReached: Boolean(run?.urlCapReached),
    timeCapReached: Boolean(run?.timeCapReached),
    runState: run ? String(run.state || "") : null,
    heartbeat: run
      ? String(run.stopReason || run.heartbeatAt || run.currentCheckpoint || "")
      : null,
  };
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
    // Runtime cache tokens do not identify different content. AJAX plugins
    // often mint a fresh timestamp for every render and otherwise create an
    // infinite frontier (`?nocache=1785216338&jet_blog_ajax=1`).
    const volatileQueryKeys =
      /^(?:nocache|cachebust|cache_bust|cb|_+|timestamp|time_stamp|ts|rnd|rand|random)$/i;
    for (const key of [...u.searchParams.keys()]) {
      if (volatileQueryKeys.test(key)) u.searchParams.delete(key);
    }
    // Static assets often carry a fresh random cache-buster on every page.
    // These parameters do not identify different bytes and otherwise create an
    // unbounded frontier (for example stemma_social.jpg?dummy=82392).
    if (/\.(?:css|m?js|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|eot)(?:$)/i.test(path)) {
      for (const key of ["dummy", "ver"]) {
        u.searchParams.delete(key);
      }
    }
    u.searchParams.sort();
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
