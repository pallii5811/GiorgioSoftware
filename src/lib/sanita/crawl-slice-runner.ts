/**
 * Resumable crawl slices on persistent frontier.
 * Slice budget expiry ≠ lead failure; reason SLICE_BUDGET_EXHAUSTED + checkpoint.
 */
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { externalFetch } from "@/lib/http";
import {
  readCrawlBudgetConfig,
  SLICE_BUDGET_EXHAUSTED,
  RUN_WALL_CLOCK_EXHAUSTED,
  type CrawlBudgetConfig,
} from "@/lib/sanita/crawl-budget";
import {
  createCrawlRun,
  upsertFrontierNode,
  transitionFrontierNode,
  heartbeatCrawlRun,
  releaseWorkerLock,
  completeCrawlRun,
  listNodes,
  setCrawlRunFlags,
  deriveCrawlCompleteness,
  computeBackoffMs,
  canonicalizeUrl,
  getCrawlRun,
  classifyTerminalMissingUrl,
  isTechnicalFetchFailure,
  persistNodeEvidence,
} from "@/lib/sanita/frontier-store";
import { extractPdfFullText } from "@/lib/sanita/ocr";
import { analyzePolicy } from "@/lib/sanita/detector";
import { shouldActivatePlaywright, type PlaywrightMode } from "@/lib/sanita/playwright-adaptive";

const TRANSPARENCY_SEEDS = [
  "/",
  "/trasparenza",
  "/amministrazione-trasparente",
  "/societa-trasparente",
  "/note-legali",
  "/assicurazione",
  "/assicurazione-rct",
  "/documenti",
  "/download",
  "/chi-siamo",
  "/privacy",
  "/cookie-policy",
  "/contatti",
  "/la-struttura",
  "/servizi",
];

export type SliceOutcome =
  | "SLICE_CHECKPOINTED"
  | "RUN_COMPLETED"
  | "RUN_WALL_CLOCK"
  | "PUBLISHED_SIGNAL"
  | "EMPTY";

export type CrawlSliceResult = {
  crawlRunId: string;
  outcome: SliceOutcome;
  stopReason: string | null;
  processed: number;
  discovered: number;
  completed: number;
  retryPending: number;
  failed: number;
  pagesText: string;
  policyText: string;
  policyFound: boolean;
  policyUrl: string | null;
  contentHash: string | null;
  playwrightUsed: boolean;
  pdfProcessed: number;
  ocrUsed: boolean;
  completenessComplete: boolean;
  wallMs: number;
};

function relevanceFor(url: string): "critical" | "relevant" | "low" {
  const policyish =
    /trasparen|polizz|assicur|amministraz|gelli|rischio|rc[to]\b|parm|pars|massimale|copertura|note-legali/i.test(
      url
    );
  if (/\.pdf/i.test(url)) return policyish ? "critical" : "low";
  if (policyish || /document/i.test(url)) return "critical";
  return "relevant";
}

function pdfNeedsOcr(url: string): boolean {
  return /trasparen|polizz|assicur|amministraz|gelli|rischio|rc[to]\b|parm|pars|massimale|copertura|note-legali/i.test(
    url
  );
}

function sameHost(a: string, b: string): boolean {
  try {
    const ha = new URL(a).hostname.replace(/^www\./i, "");
    const hb = new URL(b).hostname.replace(/^www\./i, "");
    return ha === hb || ha.endsWith(`.${hb}`) || hb.endsWith(`.${ha}`);
  } catch {
    return false;
  }
}

function enqueue(
  crawlRunId: string,
  url: string,
  parent: string | null,
  source: string
): boolean {
  try {
    const { created } = upsertFrontierNode({
      crawlRunId,
      canonicalUrl: url,
      parentUrl: parent,
      discoverySource: source,
      resourceType: /\.pdf/i.test(url) ? "pdf" : "html",
      relevance: relevanceFor(url),
    });
    return created;
  } catch {
    return false;
  }
}

function pickNextNode(
  crawlRunId: string,
  nowMs = Date.now()
): {
  id: string;
  canonicalUrl: string;
  resourceType: string;
  state: string;
  retryCount: number;
  nextRetryAt: string | null;
  discoverySource: string | null;
} | null {
  const nodes = listNodes(crawlRunId);
  const ready = nodes.filter((n) => {
    if (n.state === "DISCOVERED" || n.state === "QUEUED") return true;
    if (n.state === "FETCHING") return true; // crash resume
    if (n.state === "RETRY_PENDING") {
      if (!n.nextRetryAt) return false;
      const due = Date.parse(n.nextRetryAt);
      return Number.isFinite(due) && due <= nowMs;
    }
    return false;
  });
  // Prefer policy seed URLs first — positive PUB path must not wait for full sitemap
  ready.sort((a, b) => {
    const score = (u: string) => {
      const policyish =
        /trasparen|polizz|assicur|amministraz|gelli|rischio|rc[to]\b|parm|pars|massimale|copertura|note-legali/i.test(
          u
        );
      if (policyish && /\.pdf/i.test(u)) return 0;
      if (policyish) return 1;
      if (!/\.pdf/i.test(u)) return 2;
      return 3;
    };
    return score(a.canonicalUrl) - score(b.canonicalUrl);
  });
  return ready[0] ?? null;
}

/** Export for tests with fake clock. */
export function pickNextNodeForTest(crawlRunId: string, nowMs: number) {
  return pickNextNode(crawlRunId, nowMs);
}

async function fetchResource(
  url: string,
  budget: CrawlBudgetConfig
): Promise<{ ok: boolean; status: number; buf: Buffer; contentType: string; error?: string }> {
  const isPdf = /\.pdf/i.test(url);
  try {
    const res = await externalFetch(url, {
      timeoutMs: isPdf ? budget.pdfFetchTimeoutMs : budget.httpRequestTimeoutMs,
      redirect: "follow",
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: res.ok,
      status: res.status,
      buf,
      contentType: res.headers.get("content-type") || "",
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      buf: Buffer.alloc(0),
      contentType: "",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function discoverLinks(html: string, baseUrl: string, crawlRunId: string): number {
  let n = 0;
  const $ = cheerio.load(html);
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    try {
      const abs = new URL(href, baseUrl).toString();
      if (!sameHost(abs, baseUrl)) return;
      if (enqueue(crawlRunId, abs, baseUrl, "html-link")) n++;
    } catch {
      /* */
    }
  });
  return n;
}

export function seedCrawlFrontier(opts: {
  crawlRunId: string;
  website: string;
  extraUrls?: string[];
}): number {
  let created = 0;
  const base = opts.website.endsWith("/") ? opts.website : `${opts.website}/`;
  for (const path of TRANSPARENCY_SEEDS) {
    try {
      const u = new URL(path, base).toString();
      const source = path === "/" ? "seed" : "seed_guess";
      if (enqueue(opts.crawlRunId, u, null, source)) created++;
    } catch {
      /* */
    }
  }
  for (const u of opts.extraUrls || []) {
    if (enqueue(opts.crawlRunId, u, null, "extra")) created++;
  }
  // Queue discovered seeds
  for (const node of listNodes(opts.crawlRunId)) {
    if (node.state === "DISCOVERED") {
      try {
        transitionFrontierNode(node.id, "QUEUED");
      } catch {
        /* */
      }
    }
  }
  return created;
}

export async function runCrawlSlice(opts: {
  leadId: string;
  runId: string;
  website: string;
  workerId?: string;
  runStartedAtMs?: number;
  seedExtraUrls?: string[];
  enablePlaywright?: PlaywrightMode;
  /** When false, only seed URLs are processed (stable HOT completeness path). */
  discoverLinks?: boolean;
  budget?: Partial<CrawlBudgetConfig>;
}): Promise<CrawlSliceResult> {
  const budget = readCrawlBudgetConfig(opts.budget);
  const t0 = Date.now();
  const runStarted = opts.runStartedAtMs ?? t0;
  const { crawlRunId, resumed } = createCrawlRun({
    leadId: opts.leadId,
    runId: opts.runId,
    workerId: opts.workerId ?? "slice-runner",
  });

  if (!resumed || listNodes(crawlRunId).length === 0) {
    seedCrawlFrontier({
      crawlRunId,
      website: opts.website,
      extraUrls: opts.seedExtraUrls,
    });
  } else {
    // Re-queue only DISCOVERED. RETRY_PENDING stays until nextRetryAt (pickNextNode).
    for (const n of listNodes(crawlRunId)) {
      if (n.state === "DISCOVERED") {
        try {
          transitionFrontierNode(n.id, "QUEUED");
        } catch {
          /* */
        }
      }
      if (n.state === "FETCHING") {
        try {
          transitionFrontierNode(n.id, "RETRY_PENDING", {
            lastError: "interrupted_fetch",
            bumpRetry: true,
            nextRetryAt: new Date(Date.now() + computeBackoffMs(n.retryCount || 0)).toISOString(),
          });
        } catch {
          /* */
        }
      }
    }
  }

  heartbeatCrawlRun(crawlRunId, "slice_start");

  let processed = 0;
  let discovered = 0;
  let pagesText = "";
  let policyText = "";
  let policyFound = false;
  let policyUrl: string | null = null;
  let contentHash: string | null = null;
  let pdfProcessed = 0;
  let ocrUsed = false;
  let playwrightUsed = false;
  let playwrightError: string | null = null;
  let stopReason: string | null = null;
  let outcome: SliceOutcome = "EMPTY";
  const htmlSamples: string[] = [];
  let linksDiscoveredTotal = 0;

  const deadline = t0 + budget.sliceBudgetMs;

  while (Date.now() < deadline && processed < budget.maxHtmlPerSlice) {
    if (Date.now() - runStarted >= budget.runMaxWallClockMs) {
      stopReason = RUN_WALL_CLOCK_EXHAUSTED;
      outcome = "RUN_WALL_CLOCK";
      break;
    }

    const node = pickNextNode(crawlRunId);
    if (!node) break;

    // Cap: mark time/url cap — do NOT EXCLUDE remaining just to force HOT complete
    const completedHtml = listNodes(crawlRunId).filter(
      (n) => n.state === "COMPLETED" && n.resourceType === "html"
    ).length;
    if (completedHtml >= 40 && !/\.pdf/i.test(node.canonicalUrl)) {
      setCrawlRunFlags(crawlRunId, { urlCapReached: true });
      stopReason = "URL_CAP_REACHED";
      outcome = "RUN_WALL_CLOCK";
      break;
    }

    // Cap mid-run: do not start another heavy PDF if wall clock already exhausted
    if (Date.now() - runStarted >= budget.runMaxWallClockMs) {
      setCrawlRunFlags(crawlRunId, { timeCapReached: true });
      stopReason = RUN_WALL_CLOCK_EXHAUSTED;
      outcome = "RUN_WALL_CLOCK";
      break;
    }

    try {
      if (node.state === "DISCOVERED") transitionFrontierNode(node.id, "QUEUED");
      if (node.state === "RETRY_PENDING") transitionFrontierNode(node.id, "QUEUED");
      transitionFrontierNode(node.id, "FETCHING");
    } catch {
      /* already fetching / raced */
    }

    heartbeatCrawlRun(crawlRunId, `fetch:${canonicalizeUrl(node.canonicalUrl).slice(0, 80)}`);
    const fetched = await fetchResource(node.canonicalUrl, budget);
    processed++;

    if (!fetched.ok) {
      const retries = (node.retryCount || 0) + 1;
      const max = /\.pdf/i.test(node.canonicalUrl) ? budget.maxDocumentRetries : budget.maxUrlRetries;
      try {
        if (fetched.status === 404 || fetched.status === 410) {
          const decision = classifyTerminalMissingUrl({
            status: fetched.status as 404 | 410,
            discoverySource: node.discoverySource || "html-link",
            retryCount: node.retryCount || 0,
          });
          if (decision.state === "EXCLUDED") {
            transitionFrontierNode(node.id, "EXCLUDED", {
              httpStatus: fetched.status,
              exclusionReason: decision.reasonCode,
              lastError: decision.reasonCode,
              bumpRetry: true,
            });
          } else {
            transitionFrontierNode(node.id, "RETRY_PENDING", {
              httpStatus: fetched.status,
              lastError: decision.reasonCode,
              bumpRetry: true,
              nextRetryAt: new Date(Date.now() + computeBackoffMs(retries)).toISOString(),
            });
          }
        } else if (retries >= max && isTechnicalFetchFailure(fetched.status, fetched.error)) {
          transitionFrontierNode(node.id, "TECHNICAL_BLOCKED", {
            httpStatus: fetched.status || null,
            lastError: fetched.error || `http_${fetched.status}`,
            bumpRetry: true,
          });
        } else if (retries >= max) {
          transitionFrontierNode(node.id, "TECHNICAL_BLOCKED", {
            lastError: fetched.error || `http_${fetched.status}`,
            bumpRetry: true,
          });
        } else {
          transitionFrontierNode(node.id, "RETRY_PENDING", {
            lastError: fetched.error || `http_${fetched.status}`,
            bumpRetry: true,
            nextRetryAt: new Date(Date.now() + computeBackoffMs(retries)).toISOString(),
          });
        }
      } catch {
        /* */
      }
      await new Promise((r) => setTimeout(r, budget.perHostDelayMs));
      continue;
    }

    const hash = createHash("sha256").update(fetched.buf).digest("hex");
    try {
      transitionFrontierNode(node.id, "FETCHED", {
        httpStatus: fetched.status,
        contentType: fetched.contentType,
        contentHash: hash,
      });
    } catch {
      /* */
    }

    let text = "";
    if (/\.pdf/i.test(node.canonicalUrl) || fetched.contentType.includes("pdf")) {
      pdfProcessed++;
      const prev = process.env.OCR_JOB_TIMEOUT_MS;
      const prevOcr = process.env.OCR_ENABLED;
      // Magazine/newsletter PDFs from sitemap: process digitally, OCR only policy-ish URLs
      process.env.OCR_ENABLED = pdfNeedsOcr(node.canonicalUrl) ? "1" : "0";
      process.env.OCR_JOB_TIMEOUT_MS = String(budget.ocrTimeoutMs);
      try {
        const extracted = await extractPdfFullText(fetched.buf);
        text = extracted.text || "";
        if (extracted.ocr && (extracted.digital?.length || 0) < 200) ocrUsed = true;
        // Scanned PDF + missing renderer / timeout / extraction fail → TECHNICAL_BLOCKED (not REVIEW)
        if (
          extracted.status === "OCR_RENDERER_MISSING" ||
          extracted.status === "OCR_TIMEOUT" ||
          extracted.status === "OCR_EXTRACTION_FAILED"
        ) {
          try {
            transitionFrontierNode(node.id, "TECHNICAL_BLOCKED", {
              lastError: extracted.reasonCode || extracted.status,
              contentHash: hash,
              bumpRetry: true,
            });
          } catch {
            /* */
          }
          heartbeatCrawlRun(crawlRunId, `ocr_tech:${extracted.status}`);
          stopReason = extracted.reasonCode || extracted.status;
          // Keep processing other nodes; mark technical for finalize
          await new Promise((r) => setTimeout(r, budget.perHostDelayMs));
          continue;
        }
      } catch (e) {
        try {
          transitionFrontierNode(node.id, "RETRY_PENDING", {
            lastError: e instanceof Error ? e.message : String(e),
            bumpRetry: true,
          });
        } catch {
          /* */
        }
        continue;
      } finally {
        if (prev == null) delete process.env.OCR_JOB_TIMEOUT_MS;
        else process.env.OCR_JOB_TIMEOUT_MS = prev;
        if (prevOcr == null) delete process.env.OCR_ENABLED;
        else process.env.OCR_ENABLED = prevOcr;
      }
    } else {
      const html = fetched.buf.toString("utf8");
      if (htmlSamples.length < 3) htmlSamples.push(html.slice(0, 8000));
      text = cheerio.load(html).text().replace(/\s+/g, " ").trim();
      if (opts.discoverLinks !== false) {
        const nLinks = discoverLinks(html, node.canonicalUrl, crawlRunId);
        discovered += nLinks;
        linksDiscoveredTotal += nLinks;
        for (const n of listNodes(crawlRunId)) {
          if (n.state === "DISCOVERED") {
            try {
              transitionFrontierNode(n.id, "QUEUED");
            } catch {
              /* */
            }
          }
        }
      }
    }

    pagesText = `${pagesText}\n${text}`.slice(0, 200_000);
    const analysis = analyzePolicy(text, node.canonicalUrl);
    if (analysis.policyFound) {
      policyFound = true;
      policyUrl = node.canonicalUrl;
      policyText = text.slice(0, 40_000);
      contentHash = hash;
    }

    try {
      persistNodeEvidence({
        crawlRunId,
        nodeId: node.id,
        canonicalUrl: node.canonicalUrl,
        contentHash: hash,
        resourceType: node.resourceType || "html",
        normalizedText: text,
        policyText: analysis.policyFound ? text.slice(0, 40_000) : "",
        policyFound: Boolean(analysis.policyFound),
        policySignalsJson: analysis.policyFound ? analysis : undefined,
        ocrStatus: ocrUsed ? "USED" : null,
      });
    } catch {
      /* evidence persistence must not abort crawl */
    }

    try {
      transitionFrontierNode(node.id, "PARSED");
      transitionFrontierNode(node.id, "COMPLETED");
    } catch {
      try {
        transitionFrontierNode(node.id, "COMPLETED");
      } catch {
        /* */
      }
    }

    if (policyFound) {
      outcome = "PUBLISHED_SIGNAL";
      stopReason = "POLICY_FOUND";
      // Early exit positive path — still mark identity later by caller
      break;
    }

    await new Promise((r) => setTimeout(r, budget.perHostDelayMs));
  }

  // Adaptive / forced Playwright — never silent swallow
  const completedHtmlCount = listNodes(crawlRunId).filter(
    (n) => n.state === "COMPLETED" && n.resourceType === "html"
  ).length;
  const pwDecision = shouldActivatePlaywright({
    mode: opts.enablePlaywright ?? "adaptive",
    pagesText,
    htmlSamples,
    completedHtml: completedHtmlCount,
    policyFound,
    linksDiscovered: linksDiscoveredTotal,
  });
  if (pwDecision.activate && !policyFound && Date.now() < deadline) {
    const pwBudgetMs = Math.min(
      budget.browserNavigationTimeoutMs,
      Math.max(1000, deadline - Date.now()),
      Math.max(1000, budget.runMaxWallClockMs - (Date.now() - runStarted))
    );
    if (pwBudgetMs < 5_000) {
      heartbeatCrawlRun(crawlRunId, "playwright_skipped:wall_clock");
    } else {
    try {
      const { enrichCrawlWithPlaywright } = await import("@/lib/sanita/policy-playwright");
      const seedCrawl = {
        ok: true,
        text: pagesText || "<div id=root></div>",
        pagesVisited: listNodes(crawlRunId)
          .filter((n) => n.state === "COMPLETED")
          .map((n) => n.canonicalUrl)
          .slice(0, 5),
        policyExhaustive: false,
        foundRelevantPage: false,
        policyText: "",
        needsOcrReview: false,
      };
      process.env.PLAYWRIGHT_POLICY_MAX_MS = String(pwBudgetMs);
      heartbeatCrawlRun(crawlRunId, `playwright_start:${pwDecision.reason || "adaptive"}`);
      const enriched = await enrichCrawlWithPlaywright(opts.website, seedCrawl as never, {
        surfaceErrors: true,
      });
      playwrightUsed = true;
      if (enriched?.error && /playwright|browser|timeout|launch/i.test(enriched.error)) {
        throw new Error(enriched.error);
      }
      if (enriched?.text) pagesText = `${pagesText}\n${enriched.text}`.slice(0, 200_000);
      for (const u of enriched?.pagesVisited || []) {
        const isJson = /\.json(?:$|\?)|\/api\/|application\/json/i.test(u);
        if (enqueue(crawlRunId, u, opts.website, isJson ? "playwright_xhr" : "playwright")) {
          discovered++;
        }
      }
      for (const n of listNodes(crawlRunId)) {
        if (n.state === "DISCOVERED") {
          try {
            transitionFrontierNode(n.id, "QUEUED");
          } catch {
            /* */
          }
        }
      }
      heartbeatCrawlRun(crawlRunId, `playwright:${pwDecision.reason || "ok"}`);
    } catch (e) {
      playwrightError = e instanceof Error ? e.message : String(e);
      heartbeatCrawlRun(crawlRunId, `playwright_error:${playwrightError.slice(0, 80)}`);
      // Surface as RETRY_PENDING (new node — COMPLETED cannot transition back)
      if (enqueue(crawlRunId, opts.website, opts.website, "playwright_error")) {
        const fresh = listNodes(crawlRunId)
          .filter((x) => x.state === "DISCOVERED")
          .slice(-1)[0];
        if (fresh) {
          try {
            transitionFrontierNode(fresh.id, "RETRY_PENDING", {
              lastError: `PLAYWRIGHT_ERROR:${playwrightError.slice(0, 180)}`,
              nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
              bumpRetry: true,
            });
          } catch {
            /* */
          }
        }
      }
      stopReason = `playwright_error:${playwrightError.slice(0, 60)}`;
      outcome = "SLICE_CHECKPOINTED";
    }
    }
  }

  const nodesAfter = listNodes(crawlRunId);
  const pendingWork = nodesAfter.some((n) =>
    ["DISCOVERED", "QUEUED", "FETCHING", "RETRY_PENDING"].includes(n.state)
  );
  const retryPending = nodesAfter.filter((n) => n.state === "RETRY_PENDING").length;
  const failed = nodesAfter.filter((n) => n.state === "TECHNICAL_BLOCKED").length;
  const completed = nodesAfter.filter((n) => n.state === "COMPLETED").length;

  // Re-bind for settle. Identity/scope/sitemap MUST come from real engines — never auto-complete here.
  let settle: SliceOutcome = outcome;
  if (settle === "EMPTY" || settle === "PUBLISHED_SIGNAL") {
    if (!pendingWork && completed > 0 && settle !== "PUBLISHED_SIGNAL") {
      completeCrawlRun(crawlRunId, stopReason || "frontier_exhausted");
      settle = "RUN_COMPLETED";
      stopReason = stopReason || "frontier_exhausted";
    } else if (stopReason === RUN_WALL_CLOCK_EXHAUSTED) {
      setCrawlRunFlags(crawlRunId, { timeCapReached: true });
      heartbeatCrawlRun(crawlRunId, RUN_WALL_CLOCK_EXHAUSTED);
      releaseWorkerLock(crawlRunId);
      settle = "RUN_WALL_CLOCK";
    } else if (pendingWork || Date.now() >= deadline) {
      if (settle !== "PUBLISHED_SIGNAL") {
        stopReason = SLICE_BUDGET_EXHAUSTED;
        settle = "SLICE_CHECKPOINTED";
        heartbeatCrawlRun(crawlRunId, SLICE_BUDGET_EXHAUSTED);
        releaseWorkerLock(crawlRunId);
      }
    }
  } else if (settle === "RUN_WALL_CLOCK") {
    setCrawlRunFlags(crawlRunId, { timeCapReached: true });
    releaseWorkerLock(crawlRunId);
  }

  if (settle === "PUBLISHED_SIGNAL") {
    heartbeatCrawlRun(crawlRunId, "POLICY_FOUND");
    releaseWorkerLock(crawlRunId);
  }

  outcome = settle;

  const completeness = deriveCrawlCompleteness(crawlRunId);

  return {
    crawlRunId,
    outcome,
    stopReason,
    processed,
    discovered,
    completed,
    retryPending,
    failed,
    pagesText,
    policyText,
    policyFound,
    policyUrl,
    contentHash,
    playwrightUsed,
    pdfProcessed,
    ocrUsed,
    completenessComplete: completeness.complete,
    wallMs: Date.now() - t0,
  };
}

/** Run slices until terminal or wall clock. */
export async function runCrawlUntilSettled(opts: {
  leadId: string;
  runId: string;
  website: string;
  workerId?: string;
  seedExtraUrls?: string[];
  enablePlaywright?: PlaywrightMode;
  discoverLinks?: boolean;
  maxSlices?: number;
  budget?: Partial<CrawlBudgetConfig>;
  onSlice?: (slice: number, result: CrawlSliceResult) => void;
}): Promise<{
  slices: CrawlSliceResult[];
  final: CrawlSliceResult;
  crawlRunId: string;
}> {
  const runStartedAtMs = Date.now();
  const slices: CrawlSliceResult[] = [];
  const maxSlices = opts.maxSlices ?? 20;
  let last!: CrawlSliceResult;

  for (let i = 0; i < maxSlices; i++) {
    last = await runCrawlSlice({
      ...opts,
      runStartedAtMs,
      workerId: opts.workerId ?? `slice-${i}`,
    });
    slices.push(last);
    opts.onSlice?.(i + 1, last);
    if (
      last.outcome === "RUN_COMPLETED" ||
      last.outcome === "PUBLISHED_SIGNAL" ||
      last.outcome === "RUN_WALL_CLOCK"
    ) {
      break;
    }
    // acquire next slice — createCrawlRun resumes
  }

  return { slices, final: last, crawlRunId: last.crawlRunId };
}

export function getRunSnapshot(crawlRunId: string) {
  return {
    run: getCrawlRun(crawlRunId),
    nodes: listNodes(crawlRunId),
    completeness: deriveCrawlCompleteness(crawlRunId),
  };
}
