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
} from "@/lib/sanita/frontier-store";
import {
  runCrawlUntilSettled,
  seedCrawlFrontier,
  type CrawlSliceResult,
} from "@/lib/sanita/crawl-slice-runner";
import { externalFetch } from "@/lib/http";
import { analyzePolicy } from "@/lib/sanita/detector";

export function resolveProductFrontierPath(): string {
  if (process.env.FRONTIER_DB_PATH?.trim()) return process.env.FRONTIER_DB_PATH.trim();
  const runId =
    process.env.SHADOW_RUN_ID ||
    process.env.SANITA_RUN_ID ||
    (process.env.SHADOW_MODE === "true" || process.env.SHADOW_MODE === "1" ? "shadow" : "product");
  return defaultFrontierDbPath(runId);
}

/** Probe robots/sitemap once — sets NOT_PRESENT or DISCOVERED_PARTIAL; never fake COMPLETE. */
export async function probeSitemapStatus(
  crawlRunId: string,
  website: string
): Promise<"NOT_PRESENT" | "DISCOVERED_PARTIAL" | "DISCOVERED_FAILED" | "NOT_DISCOVERED"> {
  const base = website.endsWith("/") ? website : `${website}/`;
  try {
    const robotsUrl = new URL("/robots.txt", base).toString();
    const smUrl = new URL("/sitemap.xml", base).toString();
    let robotsOk = false;
    let smStatus = 0;
    try {
      const r = await externalFetch(robotsUrl, { timeoutMs: 8_000, redirect: "follow" });
      robotsOk = r.ok;
    } catch {
      /* */
    }
    try {
      const s = await externalFetch(smUrl, { timeoutMs: 8_000, redirect: "follow" });
      smStatus = s.status;
      if (s.ok) {
        setCrawlRunFlags(crawlRunId, { sitemapStatus: "DISCOVERED_PARTIAL" });
        return "DISCOVERED_PARTIAL";
      }
    } catch {
      smStatus = 0;
    }
    if (smStatus === 404 && (!robotsOk || smStatus === 404)) {
      setCrawlRunFlags(crawlRunId, { sitemapStatus: "NOT_PRESENT" });
      return "NOT_PRESENT";
    }
    if (smStatus === 0) {
      setCrawlRunFlags(crawlRunId, { sitemapStatus: "DISCOVERED_FAILED" });
      return "DISCOVERED_FAILED";
    }
    setCrawlRunFlags(crawlRunId, { sitemapStatus: "NOT_DISCOVERED" });
    return "NOT_DISCOVERED";
  } catch {
    setCrawlRunFlags(crawlRunId, { sitemapStatus: "DISCOVERED_FAILED" });
    return "DISCOVERED_FAILED";
  }
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
  const text = final.pagesText || "";
  const policyText = final.policyText || "";
  const foundRelevant = completed.some((u) =>
    /trasparen|polizz|assicur|amministraz|gelli|rischio|document/i.test(u)
  );
  const pdfs = nodes.filter((n) => n.resourceType === "pdf");
  const pdfsRead = pdfs.filter((n) => n.state === "COMPLETED").length;
  const pdfsQueued = pdfs.length;
  const analysis = analyzePolicy(policyText || text, final.policyUrl || undefined);

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
    foundRelevantPage: foundRelevant || Boolean(final.policyFound),
    policyExhaustive: pdfsQueued === 0 || pdfsRead >= pdfsQueued,
    policyPdfsQueued: pdfsQueued,
    policyPdfsRead: pdfsRead,
    needsOcrReview: Boolean(final.ocrUsed && !final.policyFound),
    policyPdfAnalysis: final.policyFound ? analysis : null,
    policyPdfUrl: final.policyUrl,
    emails: [],
    pec: null,
    phones: [],
    piva: null,
    completeness,
  };
}

export type LeadCrawlRuntimeResult = {
  crawl: CrawlResult;
  crawlRunId: string;
  slices: CrawlSliceResult[];
  final: CrawlSliceResult;
  frontierCreatedBeforeFetch: true;
};

/**
 * Real product crawl: CrawlRun + frontier seed BEFORE first HTTP, then slices until settled.
 */
export async function crawlLeadViaSlices(opts: {
  leadId: string;
  website: string;
  evidence?: string | null;
  runId?: string;
  maxSlices?: number;
  discoverLinks?: boolean;
  enablePlaywright?: boolean;
  /** Identity/scope flags — only from real identity engine, never defaults true. */
  identityVerified?: boolean;
  scopeVerified?: boolean;
}): Promise<LeadCrawlRuntimeResult> {
  const frontierPath = resolveProductFrontierPath();
  openFrontierStore(frontierPath);
  process.env.FRONTIER_DB_PATH = frontierPath;

  const runId = opts.runId || process.env.SHADOW_RUN_ID || `analyze-${opts.leadId}`;
  const { crawlRunId } = createCrawlRun({
    leadId: opts.leadId,
    runId,
    workerId: "scan-engine-slices",
  });

  // Frontier must exist before any HTTP (sitemap probe counts as first fetch after create)
  if (!getCrawlRun(crawlRunId)) {
    throw new Error("CrawlRun missing before fetch");
  }
  seedCrawlFrontier({
    crawlRunId,
    website: opts.website,
    extraUrls: historicalDocUrls(opts.evidence),
  });
  await probeSitemapStatus(crawlRunId, opts.website);

  const settled = await runCrawlUntilSettled({
    leadId: opts.leadId,
    runId,
    website: opts.website,
    workerId: "scan-engine-slices",
    seedExtraUrls: historicalDocUrls(opts.evidence),
    discoverLinks: opts.discoverLinks ?? true,
    enablePlaywright: opts.enablePlaywright ?? false,
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
  };
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
