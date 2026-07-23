/**
 * Production crawl path for analyzeLead — persistent frontier + slice runner.
 * crawlSite (monolithic) must NOT be used on this path.
 */
import { parseEvidenceSections } from "@/lib/sanita/audit";
import type { CrawlResult } from "@/lib/sanita/crawler";
import { deriveCrawlComplete, type CrawlCompleteness } from "@/lib/evidence/contract";
import {
  openFrontierStore,
  createCrawlRun,
  listNodes,
  setCrawlRunFlags,
  deriveCrawlCompleteness,
  defaultFrontierDbPath,
  getCrawlRun,
  aggregatePersistedEvidence,
} from "@/lib/sanita/frontier-store";
import {
  runCrawlUntilSettled,
  seedCrawlFrontier,
  type CrawlSliceResult,
} from "@/lib/sanita/crawl-slice-runner";
import { discoverAndProcessSitemaps } from "@/lib/sanita/sitemap-pipeline";
import { analyzePolicy } from "@/lib/sanita/detector";
import type { PlaywrightMode } from "@/lib/sanita/playwright-adaptive";

export function resolveProductFrontierPath(): string {
  if (process.env.FRONTIER_DB_PATH?.trim()) return process.env.FRONTIER_DB_PATH.trim();
  const runId =
    process.env.SHADOW_RUN_ID ||
    process.env.SANITA_RUN_ID ||
    (process.env.SHADOW_MODE === "true" || process.env.SHADOW_MODE === "1" ? "shadow" : "product");
  return defaultFrontierDbPath(runId);
}

function historicalDocUrls(evidence: string | null | undefined): string[] {
  const parts = parseEvidenceSections(evidence);
  return [...(parts.docs ?? []), ...((evidence || "").match(/https?:\/\/[^\s\]]+\.pdf/gi) ?? [])];
}

function aggregateCrawlResult(
  website: string,
  crawlRunId: string,
  final: CrawlSliceResult
): CrawlResult {
  const nodes = listNodes(crawlRunId);
  const completed = nodes.filter((n) => n.state === "COMPLETED").map((n) => n.canonicalUrl);
  const completeness = deriveCrawlCompleteness(crawlRunId);
  const persisted = aggregatePersistedEvidence(crawlRunId);
  const text = persisted.pagesText || final.pagesText || "";
  const policyText = persisted.policyText || final.policyText || "";
  const policyUrl = persisted.policyUrl || final.policyUrl;
  const policyFoundPersisted = persisted.policyFound || final.policyFound;
  const foundRelevant = completed.some((u) =>
    /trasparen|polizz|assicur|amministraz|gelli|rischio|document/i.test(u)
  );
  const pdfs = nodes.filter((n) => n.resourceType === "pdf");
  const pdfsRead = pdfs.filter((n) => n.state === "COMPLETED").length;
  const pdfsQueued = pdfs.length;
  const analysis = analyzePolicy(policyText || text, policyUrl || undefined);

  const ok = completed.length > 0 || final.outcome === "PUBLISHED_SIGNAL";
  let error: string | null = null;
  if (!ok) {
    if (final.outcome === "RUN_WALL_CLOCK") error = final.stopReason || "run_wall_clock";
    else if (nodes.some((n) => n.state === "RETRY_PENDING")) error = "retry_pending";
    else if (nodes.some((n) => n.state === "TECHNICAL_BLOCKED")) error = "technical_blocked";
    else error = final.stopReason || "crawl_empty";
  }

  return {
    text,
    policyText: policyText || text,
    pagesVisited: completed.length ? completed : [website],
    ok,
    error,
    foundRelevantPage: foundRelevant || Boolean(policyFoundPersisted),
    policyExhaustive: pdfsQueued === 0 || pdfsRead >= pdfsQueued,
    policyPdfsQueued: pdfsQueued,
    policyPdfsRead: pdfsRead,
    needsOcrReview: Boolean(final.ocrUsed && !policyFoundPersisted),
    policyPdfAnalysis: policyFoundPersisted ? analysis : null,
    policyPdfUrl: policyUrl,
    emails: [],
    pec: null,
    phones: [],
    piva: null,
    completeness,
  };
}

/**
 * Real product crawl: CrawlRun + frontier seed BEFORE first HTTP, then slices until settled.
 */
export type LeadCrawlRuntimeResult = {
  crawl: CrawlResult;
  crawlRunId: string;
  slices: CrawlSliceResult[];
  final: CrawlSliceResult;
  frontierCreatedBeforeFetch: true;
  sitemapStatus?: string;
  sitemapTrace?: unknown;
  playwrightMode?: PlaywrightMode;
};

export async function crawlLeadViaSlices(opts: {
  leadId: string;
  website: string;
  evidence?: string | null;
  runId?: string;
  maxSlices?: number;
  discoverLinks?: boolean;
  /** Product default: adaptive. */
  enablePlaywright?: PlaywrightMode;
  identityVerified?: boolean;
  scopeVerified?: boolean;
  /** When true, never reuse the active FRONTIER_DB_PATH (alt-TLD / side crawls). */
  isolateFrontier?: boolean;
}): Promise<LeadCrawlRuntimeResult> {
  const runId = opts.runId || process.env.SHADOW_RUN_ID || `analyze-${opts.leadId}`;
  const prevFrontier = process.env.FRONTIER_DB_PATH;
  const frontierPath =
    opts.isolateFrontier || (opts.runId && opts.runId !== process.env.SHADOW_RUN_ID)
      ? defaultFrontierDbPath(runId)
      : resolveProductFrontierPath();
  openFrontierStore(frontierPath);
  process.env.FRONTIER_DB_PATH = frontierPath;

  try {
  const { crawlRunId } = createCrawlRun({
    leadId: opts.leadId,
    runId,
    workerId: "scan-engine-slices",
  });

  if (!getCrawlRun(crawlRunId)) {
    throw new Error("CrawlRun missing before fetch");
  }
  seedCrawlFrontier({
    crawlRunId,
    website: opts.website,
    extraUrls: historicalDocUrls(opts.evidence),
  });
  const sitemap = await discoverAndProcessSitemaps(crawlRunId, opts.website);
  const pwMode: PlaywrightMode = opts.enablePlaywright ?? "adaptive";

  const settled = await runCrawlUntilSettled({
    leadId: opts.leadId,
    runId,
    website: opts.website,
    workerId: "scan-engine-slices",
    seedExtraUrls: historicalDocUrls(opts.evidence),
    discoverLinks: opts.discoverLinks ?? true,
    enablePlaywright: pwMode,
    maxSlices: opts.maxSlices ?? 24,
  });

  if (opts.identityVerified != null || opts.scopeVerified != null) {
    setCrawlRunFlags(settled.crawlRunId, {
      identityVerified: opts.identityVerified,
      scopeVerified: opts.scopeVerified,
    });
  }

  const crawl = aggregateCrawlResult(opts.website, settled.crawlRunId, settled.final);
  return {
    crawl,
    crawlRunId: settled.crawlRunId,
    slices: settled.slices,
    final: settled.final,
    frontierCreatedBeforeFetch: true,
    sitemapStatus: sitemap.status,
    sitemapTrace: sitemap.traces,
    playwrightMode: pwMode,
  };
  } finally {
    if (prevFrontier != null && prevFrontier !== "") {
      process.env.FRONTIER_DB_PATH = prevFrontier;
      try {
        openFrontierStore(prevFrontier);
      } catch {
        /* primary store may already be closed */
      }
    } else if (opts.isolateFrontier) {
      delete process.env.FRONTIER_DB_PATH;
    }
  }
}

export function applyIdentityToCrawlRun(
  crawlRunId: string,
  flags: { identityVerified: boolean; scopeVerified: boolean }
): CrawlCompleteness {
  setCrawlRunFlags(crawlRunId, flags);
  return deriveCrawlCompleteness(crawlRunId);
}

export function emptyCompleteness(): CrawlCompleteness {
  return deriveCrawlComplete({
    identityVerified: false,
    sitemapStatus: "NOT_DISCOVERED",
    htmlQueueExhausted: false,
    relevantLinksProcessed: false,
    relevantDocumentsProcessed: false,
    jsonEndpointsProcessed: false,
    sameHostScriptsProcessed: false,
    unresolvedRelevantUrls: 0,
    failedRelevantUrls: 0,
    unreadableRelevantDocuments: 0,
    criticalOcrDoubts: 0,
    urlCapReached: false,
    timeCapReached: false,
  });
}
