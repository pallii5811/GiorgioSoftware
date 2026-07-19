/**
 * Persist a successful/failed crawl into frontier SQLite, then derive completeness from DB.
 */
import {
  openFrontierStore,
  createCrawlRun,
  upsertFrontierNode,
  transitionFrontierNode,
  setCrawlRunFlags,
  completeCrawlRun,
  deriveCrawlCompleteness,
  heartbeatCrawlRun,
  type FrontierNodeState,
} from "@/lib/sanita/frontier-store";
import type { CrawlCompleteness } from "@/lib/evidence/contract";
import type { CrawlFrontierLedger } from "@/lib/sanita/crawl-frontier-ledger";
import { buildFrontierFromCrawl } from "@/lib/sanita/crawl-frontier-ledger";

export function persistCrawlIntoFrontier(opts: {
  dbPath: string;
  leadId: string;
  runId: string;
  baseUrl: string;
  pagesVisited: string[];
  policyPdfsQueued: number;
  policyPdfsRead: number;
  needsOcrReview: boolean;
  identityVerified: boolean;
  scopeVerified?: boolean;
  sitemapStatus?: CrawlCompleteness["sitemapStatus"];
  workerId?: string;
}): {
  crawlRunId: string;
  completeness: CrawlCompleteness;
  ledger: CrawlFrontierLedger;
} {
  openFrontierStore(opts.dbPath);
  const { crawlRunId } = createCrawlRun({
    leadId: opts.leadId,
    runId: opts.runId,
    workerId: opts.workerId ?? "scan-engine",
  });
  heartbeatCrawlRun(crawlRunId, "persist-pages");

  for (let i = 0; i < opts.pagesVisited.length; i++) {
    const url = opts.pagesVisited[i]!;
    const isPdf = /\.pdf(?:$|\?|#)/i.test(url);
    const { id, created } = upsertFrontierNode({
      crawlRunId,
      canonicalUrl: url,
      parentUrl: i === 0 ? null : opts.pagesVisited[0],
      discoverySource: i === 0 ? "seed" : "bfs",
      resourceType: isPdf ? "pdf" : /sitemap/i.test(url) ? "sitemap" : "html",
      relevance: isPdf || /trasparen|polizz|assicur/i.test(url) ? "critical" : "relevant",
    });
    if (created || true) {
      // Idempotent progress toward COMPLETED
      const steps: FrontierNodeState[] = ["QUEUED", "FETCHING", "FETCHED", "PARSED", "COMPLETED"];
      for (const s of steps) {
        try {
          transitionFrontierNode(id, s, { httpStatus: 200 });
        } catch {
          /* already past */
        }
      }
    }
  }

  // Unread PDFs remain pending if queued > read
  const unread = Math.max(0, opts.policyPdfsQueued - opts.policyPdfsRead);
  for (let i = 0; i < unread; i++) {
    const { id } = upsertFrontierNode({
      crawlRunId,
      canonicalUrl: `${opts.baseUrl}/__pending_pdf_${i}.pdf`,
      discoverySource: "pdf-queue",
      resourceType: "pdf",
      relevance: "critical",
      state: "DISCOVERED",
    });
    void id;
  }

  setCrawlRunFlags(crawlRunId, {
    identityVerified: opts.identityVerified,
    scopeVerified: opts.scopeVerified ?? opts.identityVerified,
    sitemapStatus: opts.sitemapStatus ?? "DISCOVERED_COMPLETE",
    ocrDoubts: opts.needsOcrReview ? 1 : 0,
    unresolvedPolicyCandidates: 0,
    urlCapReached: false,
    timeCapReached: false,
  });

  const completeness = deriveCrawlCompleteness(crawlRunId);
  if (completeness.complete) completeCrawlRun(crawlRunId, "frontier_exhausted");
  else completeCrawlRun(crawlRunId, "frontier_incomplete");

  const ledger = buildFrontierFromCrawl({
    baseUrl: opts.baseUrl,
    pagesVisited: opts.pagesVisited,
    policyPdfsQueued: opts.policyPdfsQueued,
    policyPdfsRead: opts.policyPdfsRead,
    needsOcrReview: opts.needsOcrReview,
    completeness,
    scanKey: crawlRunId,
  });

  return { crawlRunId, completeness, ledger };
}
