/**
 * CrawlFrontierLedger — prova di esaustività grafo first-party per HOT.
 * HOT_VERIFIED solo se pending/failed/retry rilevanti = 0.
 */
import type { CrawlCompleteness } from "@/lib/evidence/contract";

export type FrontierNodePhase =
  | "discovered"
  | "queued"
  | "fetched"
  | "rendered"
  | "parsed"
  | "excluded"
  | "failed"
  | "retryPending"
  | "blocked"
  | "completed";

export type FrontierExcludeReason =
  | "LOGOUT"
  | "LOGIN"
  | "CART"
  | "DUPLICATE_PARAMS"
  | "INFINITE_CALENDAR"
  | "INTERNAL_SEARCH"
  | "NON_DOCUMENT_MEDIA"
  | "TECHNICAL_IRRELEVANT"
  | "OUT_OF_SCOPE_HOST";

export type FrontierNode = {
  url: string;
  origin: string;
  type: "html" | "pdf" | "office" | "json" | "script" | "sitemap" | "robots" | "other";
  relevance: "critical" | "relevant" | "low" | "excluded";
  phase: FrontierNodePhase;
  httpStatus: number | null;
  contentType: string | null;
  parent: string | null;
  retry: number;
  error: string | null;
  excludeReason: FrontierExcludeReason | null;
  hash: string | null;
  timestamp: string;
};

export type CrawlFrontierLedger = {
  scanKey: string;
  baseUrl: string;
  nodes: FrontierNode[];
  counts: {
    discovered: number;
    queued: number;
    fetched: number;
    rendered: number;
    parsed: number;
    excluded: number;
    failed: number;
    retryPending: number;
    blocked: number;
    completed: number;
    relevantPending: number;
    relevantFailed: number;
    pdfUnresolved: number;
    ocrDoubt: number;
  };
  frontierExhausted: boolean;
  stampedAt: string;
};

export type FrontierHotBlock = string | null;

/** Costruisce ledger da risultato crawl esistente (senza toccare crawler.ts). */
export function buildFrontierFromCrawl(input: {
  baseUrl: string;
  pagesVisited: string[];
  policyPdfsQueued: number;
  policyPdfsRead: number;
  needsOcrReview: boolean;
  completeness: CrawlCompleteness | null | undefined;
  scanKey?: string;
}): CrawlFrontierLedger {
  const now = new Date().toISOString();
  const nodes: FrontierNode[] = input.pagesVisited.map((url, i) => {
    const isPdf = /\.pdf(?:$|\?|#)/i.test(url);
    return {
      url,
      origin: i === 0 ? "seed" : "bfs",
      type: isPdf ? "pdf" : /sitemap/i.test(url) ? "sitemap" : /robots\.txt/i.test(url) ? "robots" : "html",
      relevance: isPdf || /trasparen|polizz|assicur/i.test(url) ? "critical" : "relevant",
      phase: "completed" as FrontierNodePhase,
      httpStatus: 200,
      contentType: isPdf ? "application/pdf" : "text/html",
      parent: i === 0 ? null : input.pagesVisited[0] ?? null,
      retry: 0,
      error: null,
      excludeReason: null,
      hash: null,
      timestamp: now,
    };
  });

  const c = input.completeness;
  const pdfUnresolved = Math.max(0, (input.policyPdfsQueued ?? 0) - (input.policyPdfsRead ?? 0));
  const relevantPending = c?.unresolvedRelevantUrls ?? 0;
  const relevantFailed = c?.failedRelevantUrls ?? 0;
  const ocrDoubt = (c?.criticalOcrDoubts ?? 0) + (input.needsOcrReview ? 1 : 0);

  const counts = {
    discovered: nodes.length,
    queued: 0,
    fetched: nodes.length,
    rendered: nodes.filter((n) => n.type === "html").length,
    parsed: nodes.length,
    excluded: 0,
    failed: relevantFailed,
    retryPending: relevantPending > 0 ? relevantPending : 0,
    blocked: 0,
    completed: nodes.length,
    relevantPending,
    relevantFailed,
    pdfUnresolved,
    ocrDoubt,
  };

  const frontierExhausted =
    counts.relevantPending === 0 &&
    counts.relevantFailed === 0 &&
    counts.retryPending === 0 &&
    counts.pdfUnresolved === 0 &&
    counts.ocrDoubt === 0 &&
    !(c?.urlCapReached) &&
    !(c?.timeCapReached) &&
    (c?.complete === true);

  return {
    scanKey: input.scanKey ?? `crawl:${input.baseUrl}`,
    baseUrl: input.baseUrl,
    nodes,
    counts,
    frontierExhausted,
    stampedAt: now,
  };
}

export function frontierBlocksHot(ledger: CrawlFrontierLedger | null | undefined): FrontierHotBlock {
  if (!ledger) return "CrawlFrontierLedger assente";
  const r: string[] = [];
  if (!ledger.frontierExhausted) r.push("frontier non esaurito");
  if (ledger.counts.relevantPending > 0) r.push(`relevant pending=${ledger.counts.relevantPending}`);
  if (ledger.counts.relevantFailed > 0) r.push(`relevant failed=${ledger.counts.relevantFailed}`);
  if (ledger.counts.retryPending > 0) r.push(`retry pending=${ledger.counts.retryPending}`);
  if (ledger.counts.pdfUnresolved > 0) r.push(`PDF irrisolti=${ledger.counts.pdfUnresolved}`);
  if (ledger.counts.ocrDoubt > 0) r.push(`OCR dubbi=${ledger.counts.ocrDoubt}`);
  return r.length ? r.join("; ") : null;
}

const FRONTIER_RE = /\[FRONTIER:([^\]]+)\]/;

export function stampFrontierSummary(body: string, ledger: CrawlFrontierLedger): string {
  const summary = [
    ledger.frontierExhausted ? "EXHAUSTED" : "OPEN",
    `p=${ledger.counts.relevantPending}`,
    `f=${ledger.counts.relevantFailed}`,
    `pdf=${ledger.counts.pdfUnresolved}`,
    `ocr=${ledger.counts.ocrDoubt}`,
    `n=${ledger.nodes.length}`,
  ].join(",");
  return `${body.replace(FRONTIER_RE, "").trim()} [FRONTIER:${summary}]`.trim();
}
