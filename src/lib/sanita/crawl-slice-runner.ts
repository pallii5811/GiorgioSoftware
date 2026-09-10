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
  countRetryPendingMissingNextRetryAt,
  repairOrphanRetryPending,
  reclassifySpuriousRelevance,
  prepareFrontierForExhaustiveCoverage,
} from "@/lib/sanita/frontier-store";
import {
  analyzeImageVisualContent,
  extractImageText,
  extractPdfFullText,
} from "@/lib/sanita/ocr";
import { analyzePolicy, detectPolicyCandidate } from "@/lib/sanita/detector";
import { shouldActivatePlaywright, type PlaywrightMode } from "@/lib/sanita/playwright-adaptive";
import { classifyUrlRelevance } from "@/lib/sanita/crawl-relevance";
import { comparePolicyDocumentRecency } from "@/lib/sanita/policy-version-selection";
import { extractOfficeDocumentText } from "@/lib/sanita/office-document";
import {
  discoverResourcesFromHtml,
  discoverResourcesFromText,
  extractVisibleTextFromHtml,
  isClearlyDecorativeImageUrl,
  isClearlyCommercialProductImageUrl,
  isClearlyPatientConventionLogoUrl,
  isCrawlScopeResource,
  isGeneratedRuntimeRequestUrl,
  isPolicyLikeResourceUrl,
  isSameSiteResource,
  originalImageUrlForThumbnail,
  resourceTypeForContentType,
  resourceTypeForUrl,
  shouldFollowExternalResource,
  type SiteResourceType,
} from "@/lib/sanita/site-resource";

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

function boundedPolicyEvidenceText(
  text: string,
  policyNumber?: string | null,
  company?: string | null
): string {
  const lower = text.toLowerCase();
  const anchors = [
    policyNumber,
    company,
    "polizza assicurativa",
    "responsabilità civile",
    "responsabilita civile",
    "copertura assicurativa",
  ].filter((value): value is string => Boolean(value?.trim()));
  let index = -1;
  for (const anchor of anchors) {
    index = lower.indexOf(anchor.toLowerCase());
    if (index >= 0) break;
  }
  if (index < 0) return text.slice(0, 40_000);
  const start = Math.max(0, index - 2_000);
  return text.slice(start, start + 40_000);
}

function relevanceFor(
  url: string,
  discoverySource?: string | null
): "critical" | "relevant" | "low" {
  return classifyUrlRelevance(url, { discoverySource });
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

/** Registrable domain (naive eTLD+1) — .it ≠ .com even with same label. */
function registrableDomain(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    const parts = host.split(".").filter(Boolean);
    if (parts.length < 2) return host || null;
    return parts.slice(-2).join(".");
  } catch {
    return null;
  }
}

function sameRegistrableSite(a: string, b: string): boolean {
  const da = registrableDomain(a);
  const db = registrableDomain(b);
  return Boolean(da && db && da === db);
}

/**
 * RC-11: seed/seed_guess su TLD gemello DNS-morto (alt-TLD pollution) non sono
 * frontier rilevante — EXCLUDED come host esterno irrilevante.
 */
function excludeForeignSeedNodes(crawlRunId: string, website: string): number {
  let n = 0;
  for (const node of listNodes(crawlRunId)) {
    const src = String(node.discoverySource || "");
    if (src !== "seed" && src !== "seed_guess") continue;
    if (sameRegistrableSite(node.canonicalUrl, website)) continue;
    if (node.state === "EXCLUDED" || node.state === "COMPLETED") continue;
    try {
      transitionFrontierNode(node.id, "EXCLUDED", {
        lastError: "EXTERNAL_HOST_IRRELEVANT",
        exclusionReason: "EXTERNAL_HOST_IRRELEVANT",
      });
      n++;
    } catch {
      /* FSM edge — leave for circuit/resume */
    }
  }
  return n;
}

function enqueue(
  crawlRunId: string,
  url: string,
  parent: string | null,
  source: string,
  resourceType?: SiteResourceType
): boolean {
  try {
    if (isGeneratedRuntimeRequestUrl(url)) return false;
    const { created } = upsertFrontierNode({
      crawlRunId,
      canonicalUrl: url,
      parentUrl: parent,
      discoverySource: source,
      resourceType: resourceType ?? resourceTypeForUrl(url),
      relevance: relevanceFor(url, source),
    });
    return created;
  } catch {
    return false;
  }
}

function pickNextNode(
  crawlRunId: string,
  nowMs = Date.now(),
  opts?: { pdfOnly?: boolean }
): {
  id: string;
  canonicalUrl: string;
  parentUrl: string | null;
  resourceType: string;
  relevance: string;
  state: string;
  retryCount: number;
  nextRetryAt: string | null;
  discoverySource: string | null;
} | null {
  const nodes = listNodes(crawlRunId);
  const ready = nodes.filter((n) => {
    if (opts?.pdfOnly && !(n.resourceType === "pdf" || /\.pdf/i.test(n.canonicalUrl))) return false;
    if (n.state === "DISCOVERED" || n.state === "QUEUED") return true;
    if (n.state === "RETRY_PENDING") {
      if (!n.nextRetryAt) return false;
      const due = Date.parse(n.nextRetryAt);
      return Number.isFinite(due) && due <= nowMs;
    }
    return false;
  });
  // Prefer policy docs first; all PDFs before generic HTML so documents are not starved.
  ready.sort((a, b) => {
    const score = (node: (typeof ready)[number]) => {
      const u = node.canonicalUrl;
      const policyish =
        /trasparen|polizz|assicur|amministraz|gelli|rischio|rc[to]\b|parm|pars|massimale|copertura|note-legali/i.test(
          u
        );
      const isDocument =
        /^(?:pdf|document|office|image)$/i.test(node.resourceType) ||
        /\.pdf(?:$|[?#])/i.test(u);
      const relevance =
        node.relevance === "critical" ? 0 : node.relevance === "relevant" ? 1 : 2;
      if (policyish && isDocument) return [0, relevance];
      if (policyish) return [1, relevance];
      if (isDocument) return [2, relevance];
      return [3, relevance];
    };
    const sa = score(a);
    const sb = score(b);
    return (
      sa[0] - sb[0] ||
      sa[1] - sb[1] ||
      comparePolicyDocumentRecency(a, b)
    );
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
  const isDocument = /^(?:pdf|office|image)$/.test(resourceTypeForUrl(url));
  const maxBytes = Math.max(
    1_000_000,
    Number(process.env.CRAWL_MAX_RESOURCE_BYTES || 80 * 1024 * 1024)
  );
  try {
    const res = await externalFetch(url, {
      timeoutMs: isDocument ? budget.pdfFetchTimeoutMs : budget.httpRequestTimeoutMs,
      redirect: "follow",
    });
    const declaredLength = Number(res.headers.get("content-length") || 0);
    if (declaredLength > maxBytes) {
      return {
        ok: false,
        status: res.status,
        buf: Buffer.alloc(0),
        contentType: res.headers.get("content-type") || "",
        error: `RESOURCE_TOO_LARGE:${declaredLength}`,
      };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      return {
        ok: false,
        status: res.status,
        buf: Buffer.alloc(0),
        contentType: res.headers.get("content-type") || "",
        error: `RESOURCE_TOO_LARGE:${buf.length}`,
      };
    }
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

function discoverLinks(
  html: string,
  pageUrl: string,
  website: string,
  crawlRunId: string
): number {
  let n = 0;
  for (const resource of discoverResourcesFromHtml(html, pageUrl, website)) {
    if (
      enqueue(
        crawlRunId,
        resource.url,
        pageUrl,
        resource.discoverySource,
        resource.resourceType
      )
    ) {
      n++;
    }
  }
  return n;
}

function discoverTextResources(
  text: string,
  resourceUrl: string,
  website: string,
  crawlRunId: string
): number {
  let n = 0;
  for (const resource of discoverResourcesFromText(text, resourceUrl, website)) {
    if (
      enqueue(
        crawlRunId,
        resource.url,
        resourceUrl,
        resource.discoverySource,
        resource.resourceType
      )
    ) {
      n++;
    }
  }
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
  const exhaustiveSite = process.env.CRAWL_REQUIRE_EXHAUSTIVE_SITE === "1";
  const renderEveryHtml =
    exhaustiveSite && process.env.CRAWL_RENDER_EVERY_HTML === "1";
  // A wall-clock boundary checkpoints a resumable run; it is not a permanent
  // property of the frontier. Clear it when a new slice resumes the same graph.
  if (resumed) {
    const htmlUrlCap = Number(process.env.CRAWL_HTML_URL_CAP || 100);
    setCrawlRunFlags(crawlRunId, {
      timeCapReached: false,
      ocrDoubts: 0,
      // Il runner territoriale esaustivo usa cap=0: un vecchio checkpoint con
      // urlCapReached=1 non deve rendere la frontiera impossibile da chiudere.
      ...(htmlUrlCap === 0 ? { urlCapReached: false } : {}),
    });
    if (exhaustiveSite) {
      const reopened = prepareFrontierForExhaustiveCoverage(crawlRunId);
      if (reopened > 0) {
        heartbeatCrawlRun(crawlRunId, `exhaustive_reopened:${reopened}`);
      }
    }
  }

  if (!resumed || listNodes(crawlRunId).length === 0) {
    seedCrawlFrontier({
      crawlRunId,
      website: opts.website,
      extraUrls: opts.seedExtraUrls,
    });
  } else {
    // Re-queue interrupted discovery. TECHNICAL_BLOCKED has already exhausted
    // its bounded retry budget and remains fail-closed; reopening it on every
    // resume creates permanent OCR/fetch loops. A deliberate recertification
    // migration can still reopen a node explicitly.
    // RETRY_PENDING stays until nextRetryAt (pickNextNode).
    for (const n of listNodes(crawlRunId)) {
      if (n.state === "FETCHING" || n.state === "FETCHED") {
        // Solo l'avvio/resume puo recuperare un nodo interrotto. pickNextNode
        // non seleziona stati gia in lavorazione: con piu slice concorrenti
        // farlo produrrebbe OCR duplicati sullo stesso file e retry illimitati.
        try {
          transitionFrontierNode(n.id, "RETRY_PENDING", {
            nextRetryAt: new Date().toISOString(),
            lastError:
              n.state === "FETCHING"
                ? "INTERRUPTED_FETCH_RESUME"
                : "INTERRUPTED_PARSE_RESUME",
            bumpRetry: true,
          });
        } catch {
          /* */
        }
      }
      if (n.state === "DISCOVERED") {
        try {
          transitionFrontierNode(n.id, "QUEUED");
        } catch {
          /* */
        }
      }
      if (n.state === "TECHNICAL_BLOCKED") {
        const lastError = String(n.lastError || "");
        const circuit = /^host_circuit_open@(\d+)/.exec(lastError);
        const circuitReprobeMs = Math.max(
          60_000,
          Number(
            process.env.CRAWL_HOST_CIRCUIT_REPROBE_MS || 6 * 3_600_000
          )
        );
        const circuitIsDue = Boolean(
          circuit &&
            Number(circuit[1]) > 0 &&
            Date.now() - Number(circuit[1]) >= circuitReprobeMs
        );
        // A path-specific WAF response gets a small, bounded browser-escalation
        // allowance. OCR/content-quality failures never reopen automatically.
        const wafRetryLimit =
          budget.maxUrlRetries + Math.max(1, budget.maxBrowserRetries);
        const wafEscalationDue =
          /^(?:reopen:)*http_(?:403|429)$/i.test(lastError) &&
          (n.retryCount || 0) < wafRetryLimit;
        const imageVisualReclassificationDue =
          /^IMAGE_OCR_(?:LOW_CONFIDENCE|EMPTY)(?::VISUAL_V\d+)?$/i.test(
            lastError
          );
        const imageFetchReprobeDue =
          n.resourceType === "image" &&
          /(?:fetch failed|terminated|ECONNRESET|ETIMEDOUT|socket hang up)/i.test(
            lastError
          ) &&
          // Image/document downloads may outlive a stale pooled connection.
          // Keep recovery bounded, but allow enough independent probes to
          // distinguish a transient transport failure from a real blocker.
          (n.retryCount || 0) < budget.maxDocumentRetries + 4;
        if (
          circuitIsDue ||
          wafEscalationDue ||
          imageVisualReclassificationDue ||
          imageFetchReprobeDue
        ) {
          try {
            transitionFrontierNode(n.id, "RETRY_PENDING", {
              lastError: `reopen:${lastError || "technical_blocked"}`,
              nextRetryAt: new Date().toISOString(),
            });
          } catch {
            /* */
          }
        }
      }
    }
  }
  // RC-11: drop alt-TLD seed pollution (.com DNS-dead vs official .it) before drain.
  excludeForeignSeedNodes(crawlRunId, opts.website);
  // STOP-SHIP: never leave RETRY_PENDING orphans without nextRetryAt.
  repairOrphanRetryPending(crawlRunId);
  const demoted = reclassifySpuriousRelevance(crawlRunId, classifyUrlRelevance);
  if (demoted > 0) {
    heartbeatCrawlRun(crawlRunId, `relevance_demoted:${demoted}`);
  }
  // Hard 404/410 already retried once → EXCLUDE (do not starve behind large QUEUED).
  let excluded404 = 0;
  for (const n of listNodes(crawlRunId)) {
    if (n.state !== "RETRY_PENDING") continue;
    const err = String(n.lastError || "");
    if (!/^HTTP_404$|^HTTP_410$/i.test(err) && n.httpStatus !== 404 && n.httpStatus !== 410) continue;
    if ((n.retryCount || 0) < 1) continue;
    const decision = classifyTerminalMissingUrl({
      status: (n.httpStatus === 410 ? 410 : 404) as 404 | 410,
      discoverySource: n.discoverySource || "html-link",
      retryCount: Math.max(n.retryCount || 0, 1),
    });
    try {
      transitionFrontierNode(n.id, decision.state === "EXCLUDED" ? "EXCLUDED" : "TECHNICAL_BLOCKED", {
        exclusionReason: decision.reasonCode,
        lastError: decision.reasonCode,
        httpStatus: n.httpStatus || 404,
      });
      excluded404++;
    } catch {
      /* */
    }
  }
  if (excluded404 > 0) {
    heartbeatCrawlRun(crawlRunId, `http404_excluded:${excluded404}`);
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

  // --- resilience (k3): progress watchdog + per-host circuit breaker ---------
  // Watchdog: se la frontier non fa progressi per stallMs → stop diagnostico,
  // mai terminale commerciale (il parent rischedula; resume preservato).
  const stallMs = Math.max(1000, Number(process.env.CRAWL_NODE_STALL_MS || 600_000));
  let lastProgressAt = Date.now();
  // Circuit breaker: soglia fallimenti di rete consecutivi per host; a circuito
  // aperto i nodi pending dello stesso host vengono bloccati SENZA altri fetch
  // (un host DNS-morto non può bruciare il wall clock con 90+ retry).
  const circuitThreshold = Math.max(2, Number(process.env.CRAWL_HOST_CIRCUIT_THRESHOLD || 3));
  const hostNetFailures = new Map<string, number>();
  const hostOf = (u: string): string | null => {
    try {
      return new URL(u).hostname.toLowerCase();
    } catch {
      return null;
    }
  };
  const browserEscalationEnabled = process.env.CRAWL_BROWSER_ESCALATION !== "0";
  // Blocco circuito tramite transizioni FSM legali (DISCOVERED/QUEUED non possono
  // andare diretti a TECHNICAL_BLOCKED — il throw silenzioso annullerebbe il blocco).
  function blockNodeForCircuit(nodeId: string, lastError: string): void {
    const tryT = (to: "QUEUED" | "FETCHING" | "TECHNICAL_BLOCKED", bump = false): boolean => {
      try {
        transitionFrontierNode(nodeId, to, bump ? { lastError, bumpRetry: true } : {});
        return true;
      } catch {
        return false;
      }
    };
    if (tryT("TECHNICAL_BLOCKED", true)) return; // RETRY_PENDING/FETCHING/FETCHED
    if (tryT("QUEUED")) tryT("FETCHING");
    tryT("TECHNICAL_BLOCKED", true);
  }
  let sliceBrowser: import("playwright").Browser | null = null;
  let sliceBrowserContext: import("playwright").BrowserContext | null = null;
  async function fetchSinglePageViaBrowser(
    url: string
  ): Promise<{
    ok: boolean;
    html: string;
    status: number;
    networkResources: Array<{
      url: string;
      contentType: string;
      method: string;
      status: number;
      bodyText?: string;
    }>;
    error?: string;
  }> {
    try {
      if (!sliceBrowser) {
        const { chromium } = await import("playwright");
        const { playwrightChromiumLaunchOptions } = await import("@/lib/sanita/playwright-launch");
        sliceBrowser = await chromium.launch(playwrightChromiumLaunchOptions());
      }
      if (!sliceBrowserContext) {
        sliceBrowserContext = await sliceBrowser.newContext({
          locale: "it-IT",
          userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        });
      }
      const page = await sliceBrowserContext.newPage();
      const networkResources = new Map<
        string,
        {
          url: string;
          contentType: string;
          method: string;
          status: number;
          bodyText?: string;
        }
      >();
      const responseCaptures: Promise<void>[] = [];
      page.on("response", (response) => {
        try {
          const resourceUrl = response.url();
          const contentType = response.headers()["content-type"] || "";
          const item: {
            url: string;
            contentType: string;
            method: string;
            status: number;
            bodyText?: string;
          } = {
            url: resourceUrl,
            contentType,
            method: response.request().method(),
            status: response.status(),
          };
          networkResources.set(resourceUrl, item);
          const declaredLength = Number(response.headers()["content-length"] || 0);
          if (
            item.status >= 200 &&
            item.status < 300 &&
            (!declaredLength || declaredLength <= 2_000_000) &&
            /json|xml|text\/plain|javascript/i.test(contentType)
          ) {
            responseCaptures.push(
              response
                .text()
                .then((bodyText) => {
                  item.bodyText = bodyText.slice(0, 500_000);
                })
                .catch(() => {})
            );
          }
        } catch {
          /* response URL may be unavailable after context close */
        }
      });
      try {
        const resp = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: budget.browserNavigationTimeoutMs,
        });
        const status = resp?.status() || 0;
        if (status >= 400) {
          return {
            ok: false,
            html: "",
            status,
            networkResources: [],
            error: `browser_http_${status}`,
          };
        }
        await page
          .waitForLoadState("networkidle", {
            timeout: Math.min(1500, budget.browserNavigationTimeoutMs),
          })
          .catch(() => {});
        const performanceUrls = await page
          .evaluate(() =>
            performance
              .getEntriesByType("resource")
              .map((entry) => entry.name)
              .filter(Boolean)
          )
          .catch(() => [] as string[]);
        for (const resourceUrl of performanceUrls) {
          if (!networkResources.has(resourceUrl)) {
            networkResources.set(resourceUrl, {
              url: resourceUrl,
              contentType: "",
              method: "GET",
              status: 200,
            });
          }
        }
        // k3 2026-07-30: le capture sono best-effort — una risposta che non
        // si chiude mai (stream/chunked appeso) non deve parcheggiare il lead
        // per 14+ minuti fino allo stall watchdog. Timeout duro condiviso.
        const captureSettleMs = Math.min(
          10_000,
          Math.max(2_000, budget.browserNavigationTimeoutMs)
        );
        await Promise.race([
          Promise.allSettled(responseCaptures),
          new Promise((resolve) => setTimeout(resolve, captureSettleMs)),
        ]);
        const html = await Promise.race([
          page.content(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("page_content_timeout")), captureSettleMs)
          ),
        ]);
        return {
          ok: true,
          html: html as string,
          status: status || 200,
          networkResources: [...networkResources.values()],
        };
      } finally {
        await page.close().catch(() => {});
      }
    } catch (e) {
      return {
        ok: false,
        html: "",
        status: 0,
        networkResources: [],
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  const deadline = t0 + budget.sliceBudgetMs;

  while (Date.now() < deadline && processed < budget.maxHtmlPerSlice) {
    if (Date.now() - runStarted >= budget.runMaxWallClockMs) {
      stopReason = RUN_WALL_CLOCK_EXHAUSTED;
      outcome = "RUN_WALL_CLOCK";
      break;
    }

    let node = pickNextNode(crawlRunId);
    if (!node) break;

    // Progress watchdog: nessun progresso frontier da stallMs → stop diagnostico.
    if (Date.now() - lastProgressAt > stallMs) {
      stopReason = "NODE_STALL_WATCHDOG";
      heartbeatCrawlRun(crawlRunId, "NODE_STALL_WATCHDOG");
      break;
    }

    const nodeHost = hostOf(node.canonicalUrl);
    // RC-11: seed su host fuori registrable domain del website ufficiale → EXCLUDE, non circuito.
    if (
      node.canonicalUrl &&
      !sameRegistrableSite(node.canonicalUrl, opts.website) &&
      (String(node.discoverySource || "") === "seed" ||
        String(node.discoverySource || "") === "seed_guess")
    ) {
      try {
        transitionFrontierNode(node.id, "EXCLUDED", {
          lastError: "EXTERNAL_HOST_IRRELEVANT",
          exclusionReason: "EXTERNAL_HOST_IRRELEVANT",
        });
      } catch {
        blockNodeForCircuit(node.id, `external_host@${Date.now()}:${nodeHost || "?"}`);
      }
      continue;
    }
    // Circuito aperto su questo host → niente fetch: blocco immediato diagnostico.
    if (nodeHost && (hostNetFailures.get(nodeHost) || 0) >= circuitThreshold) {
      blockNodeForCircuit(node.id, `host_circuit_open@${Date.now()}:${nodeHost}`);
      continue;
    }
    // Cap HTML breadth — never mark urlCapReached when only low nodes remain.
    // Exclude surplus low with LOW_RELEVANCE_BREADTH_CAP; keep draining critical/relevant/PDF.
    const completedHtml = listNodes(crawlRunId).filter(
      (n) => n.state === "COMPLETED" && n.resourceType === "html"
    ).length;
    const htmlCap = Number(process.env.CRAWL_HTML_URL_CAP || 100);
    const nodeIsPdf = node.resourceType === "pdf" || /\.pdf/i.test(node.canonicalUrl);
    if (Number.isFinite(htmlCap) && htmlCap > 0 && completedHtml >= htmlCap) {
      if (exhaustiveSite) {
        // Exhaustive certification may checkpoint at a cap, but it must never
        // discard the remaining graph and call that absence.
        setCrawlRunFlags(crawlRunId, { urlCapReached: true });
        stopReason = "EXHAUSTIVE_HTML_URL_CAP";
        outcome = "SLICE_CHECKPOINTED";
        break;
      }
      const pendingLowHtml = listNodes(crawlRunId).filter(
        (n) =>
          ["DISCOVERED", "QUEUED", "RETRY_PENDING", "FETCHING"].includes(n.state) &&
          n.relevance === "low" &&
          !(n.resourceType === "pdf" || /\.pdf/i.test(n.canonicalUrl))
      );
      for (const low of pendingLowHtml) {
        try {
          if (low.state === "RETRY_PENDING" || low.state === "DISCOVERED") {
            transitionFrontierNode(low.id, "QUEUED");
          }
          if (low.state === "QUEUED" || low.state === "DISCOVERED" || low.state === "RETRY_PENDING") {
            // FSM: EXCLUDED from QUEUED
            transitionFrontierNode(low.id, "EXCLUDED", {
              lastError: "LOW_RELEVANCE_BREADTH_CAP",
              exclusionReason: "LOW_RELEVANCE_BREADTH_CAP",
            });
          }
        } catch {
          try {
            transitionFrontierNode(low.id, "EXCLUDED", {
              lastError: "LOW_RELEVANCE_BREADTH_CAP",
              exclusionReason: "LOW_RELEVANCE_BREADTH_CAP",
            });
          } catch {
            /* */
          }
        }
      }
      if (!nodeIsPdf && node.relevance === "low") {
        try {
          transitionFrontierNode(node.id, "EXCLUDED", {
            lastError: "LOW_RELEVANCE_BREADTH_CAP",
            exclusionReason: "LOW_RELEVANCE_BREADTH_CAP",
          });
        } catch {
          /* */
        }
        const pdfNode = pickNextNode(crawlRunId, Date.now(), { pdfOnly: true });
        const next = pdfNode || pickNextNode(crawlRunId);
        if (!next) {
          stopReason = "LOW_RELEVANCE_BREADTH_CAP";
          break;
        }
        node = next;
      } else if (!nodeIsPdf) {
        // critical/relevant HTML still allowed past cap — do NOT set urlCapReached
        const nextCrit = pickNextNode(crawlRunId);
        if (nextCrit) node = nextCrit;
      }
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
    // Stall guard in-flight: se il fetch supera stallMs senza concludersi, il nodo
    // resta recuperabile al resume e il run si ferma con diagnosi (mai terminale).
    const fetchPromise = fetchResource(node.canonicalUrl, budget);
    fetchPromise.catch(() => {});
    let stallTimer: NodeJS.Timeout | null = null;
    const stallRace = new Promise<"stall">((resolve) => {
      stallTimer = setTimeout(() => resolve("stall"), stallMs);
      stallTimer.unref?.();
    });
    const raced = await Promise.race([fetchPromise, stallRace]);
    if (stallTimer) clearTimeout(stallTimer);
    if (raced === "stall") {
      stopReason = "NODE_STALL_WATCHDOG";
      heartbeatCrawlRun(crawlRunId, "NODE_STALL_WATCHDOG:inflight");
      break;
    }
    let fetched = raced;
    processed++;
    lastProgressAt = Date.now(); // ogni fetch concluso (ok o errore) è progresso reale

    // Escalation WAF: 403/429 su HTML → un tentativo via browser reale prima di
    // classificare come tecnico (root cause RC-02: 403 path-specifico su WAF).
    if (
      !fetched.ok &&
      (fetched.status === 403 || fetched.status === 429) &&
      !/\.pdf/i.test(node.canonicalUrl) &&
      browserEscalationEnabled
    ) {
      heartbeatCrawlRun(crawlRunId, `browser_escalation_try:${nodeHost || "?"}`);
      const viaBrowser = await fetchSinglePageViaBrowser(node.canonicalUrl);
      if (viaBrowser.ok) {
        fetched = {
          ok: true,
          status: viaBrowser.status || 200,
          buf: Buffer.from(viaBrowser.html, "utf8"),
          contentType: "text/html; charset=utf-8",
        };
        heartbeatCrawlRun(crawlRunId, `browser_escalation_ok:${nodeHost || "?"}`);
      } else {
        heartbeatCrawlRun(
          crawlRunId,
          `browser_escalation_fail:${(viaBrowser.error || "unknown").slice(0, 80)}`
        );
      }
    }

    // Circuit breaker: conteggio fallimenti di rete consecutivi per host.
    if (nodeHost) {
      if (fetched.ok) {
        hostNetFailures.delete(nodeHost);
      } else if (!fetched.status) {
        const fails = (hostNetFailures.get(nodeHost) || 0) + 1;
        hostNetFailures.set(nodeHost, fails);
        if (fails >= circuitThreshold) {
          // Apri il circuito: tutti i nodi pending dello stesso host bloccati senza fetch.
          for (const x of listNodes(crawlRunId)) {
            if (
              (x.state === "DISCOVERED" || x.state === "QUEUED" || x.state === "RETRY_PENDING") &&
              hostOf(x.canonicalUrl) === nodeHost
            ) {
              blockNodeForCircuit(
                x.id,
                `host_circuit_open@${Date.now()}:${(fetched.error || "network").slice(0, 100)}`
              );
            }
          }
          heartbeatCrawlRun(crawlRunId, `host_circuit_open:${nodeHost}`);
          stopReason = `host_circuit_open:${nodeHost}`;
          lastProgressAt = Date.now();
          continue;
        }
      }
    }

    if (!fetched.ok) {
      const retries = (node.retryCount || 0) + 1;
      const max =
        /^(?:pdf|document|office|image)$/i.test(node.resourceType) ||
        /\.pdf(?:$|[?#])/i.test(node.canonicalUrl)
          ? budget.maxDocumentRetries
          : budget.maxUrlRetries;
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
    const resourceType = resourceTypeForContentType(
      node.canonicalUrl,
      fetched.contentType
    );
    try {
      transitionFrontierNode(node.id, "FETCHED", {
        httpStatus: fetched.status,
        contentType: fetched.contentType,
        contentHash: hash,
        resourceType,
      });
    } catch {
      /* */
    }

    const declaredType = node.resourceType || resourceTypeForUrl(node.canonicalUrl);
    const staticAssetHtmlFallback =
      resourceType === "html" &&
      /^(?:image|script|style|xml|other)$/i.test(declaredType) &&
      !isPolicyLikeResourceUrl(node.canonicalUrl);
    if (staticAssetHtmlFallback) {
      try {
        transitionFrontierNode(node.id, "EXCLUDED", {
          lastError: "STATIC_ASSET_HTML_FALLBACK",
          exclusionReason: "STATIC_ASSET_HTML_FALLBACK",
          contentHash: hash,
        });
      } catch {
        /* safe terminal exclusion; a later resume can retry cleanup */
      }
      continue;
    }

    let text = "";
    let nodeOcrStatus: string | null = null;
    let playwrightSource: string | null = null;
    if (resourceType === "pdf") {
      pdfProcessed++;
      const prev = process.env.OCR_JOB_TIMEOUT_MS;
      // Stop-ship: never disable OCR via URL heuristics — thin PDFs must hit real pdftoppm.
      process.env.OCR_JOB_TIMEOUT_MS = String(budget.ocrTimeoutMs);
      try {
        const extracted = await extractPdfFullText(fetched.buf);
        text = extracted.text || "";
        nodeOcrStatus = extracted.status;
        if (
          extracted.rasterize?.status === "OK" ||
          (extracted.ocr && (extracted.digital?.length || 0) < 200)
        ) {
          ocrUsed = true;
        }
        if (extracted.rasterize?.rendererPath) {
          heartbeatCrawlRun(
            crawlRunId,
            `ocr_renderer:${extracted.rasterize.rendererPath}:${extracted.status}`
          );
        }
        // OCR_RENDERER_MISSING → TECHNICAL_BLOCKED immediate.
        // OCR_TIMEOUT / OCR_EXTRACTION_FAILED → retry with nextRetryAt until maxDocumentRetries.
        if (extracted.status === "OCR_RENDERER_MISSING") {
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
          await new Promise((r) => setTimeout(r, budget.perHostDelayMs));
          continue;
        }
        if (
          extracted.status === "OCR_TIMEOUT" ||
          extracted.status === "OCR_EXTRACTION_FAILED" ||
          (extracted.status === "OCR_EMPTY" &&
            (extracted.digital?.length || 0) < 200) ||
          (extracted.status === "OCR_LOW_CONFIDENCE" &&
            (extracted.digital?.length || 0) < 200)
        ) {
          setCrawlRunFlags(crawlRunId, { ocrDoubts: 1 });
          const retries = (node.retryCount || 0) + 1;
          const max = budget.maxDocumentRetries;
          try {
            if (retries >= max) {
              transitionFrontierNode(node.id, "TECHNICAL_BLOCKED", {
                lastError: extracted.reasonCode || extracted.status,
                contentHash: hash,
                bumpRetry: true,
              });
            } else {
              transitionFrontierNode(node.id, "RETRY_PENDING", {
                lastError: extracted.reasonCode || extracted.status,
                contentHash: hash,
                bumpRetry: true,
                nextRetryAt: new Date(Date.now() + computeBackoffMs(retries)).toISOString(),
              });
            }
          } catch {
            /* */
          }
          heartbeatCrawlRun(crawlRunId, `ocr_retry:${extracted.status}:a${retries}`);
          stopReason = extracted.reasonCode || extracted.status;
          await new Promise((r) => setTimeout(r, budget.perHostDelayMs));
          continue;
        }
      } catch (e) {
        const retries = (node.retryCount || 0) + 1;
        const max = budget.maxDocumentRetries;
        try {
          if (retries >= max) {
            transitionFrontierNode(node.id, "TECHNICAL_BLOCKED", {
              lastError: e instanceof Error ? e.message : String(e),
              bumpRetry: true,
            });
          } else {
            transitionFrontierNode(node.id, "RETRY_PENDING", {
              lastError: e instanceof Error ? e.message : String(e),
              bumpRetry: true,
              nextRetryAt: new Date(Date.now() + computeBackoffMs(retries)).toISOString(),
            });
          }
        } catch {
          /* */
        }
        continue;
      } finally {
        if (prev == null) delete process.env.OCR_JOB_TIMEOUT_MS;
        else process.env.OCR_JOB_TIMEOUT_MS = prev;
      }
    } else if (resourceType === "office") {
      const extracted = extractOfficeDocumentText(
        fetched.buf,
        node.canonicalUrl,
        fetched.contentType
      );
      text = extracted.text;
      if (extracted.status !== "SUCCESS" && extracted.status !== "EMPTY") {
        const retries = (node.retryCount || 0) + 1;
        const lastError = `OFFICE_${extracted.status}`;
        try {
          if (retries >= budget.maxDocumentRetries) {
            transitionFrontierNode(node.id, "TECHNICAL_BLOCKED", {
              lastError,
              contentHash: hash,
              bumpRetry: true,
            });
          } else {
            transitionFrontierNode(node.id, "RETRY_PENDING", {
              lastError,
              contentHash: hash,
              bumpRetry: true,
              nextRetryAt: new Date(Date.now() + computeBackoffMs(retries)).toISOString(),
            });
          }
        } catch {
          /* */
        }
        continue;
      }
      let embeddedOcrFailure: string | null = null;
      for (const image of extracted.embeddedImages) {
        ocrUsed = true;
        const embedded = await extractImageText(image);
        nodeOcrStatus = embedded.status;
        if (embedded.text) text = `${text}\n${embedded.text}`.trim();
        if (
          embedded.status === "OCR_TIMEOUT" ||
          embedded.status === "OCR_EXTRACTION_FAILED" ||
          embedded.status === "OCR_EMPTY" ||
          embedded.status === "OCR_LOW_CONFIDENCE"
        ) {
          embeddedOcrFailure = embedded.status;
          break;
        }
      }
      if (embeddedOcrFailure) {
        setCrawlRunFlags(crawlRunId, { ocrDoubts: 1 });
        const retries = (node.retryCount || 0) + 1;
        try {
          if (retries >= budget.maxDocumentRetries) {
            transitionFrontierNode(node.id, "TECHNICAL_BLOCKED", {
              lastError: `OFFICE_EMBEDDED_${embeddedOcrFailure}`,
              contentHash: hash,
              bumpRetry: true,
            });
          } else {
            transitionFrontierNode(node.id, "RETRY_PENDING", {
              lastError: `OFFICE_EMBEDDED_${embeddedOcrFailure}`,
              contentHash: hash,
              bumpRetry: true,
              nextRetryAt: new Date(Date.now() + computeBackoffMs(retries)).toISOString(),
            });
          }
        } catch {
          /* */
        }
        continue;
      }
    } else if (resourceType === "image") {
      const originalImageUrl = originalImageUrlForThumbnail(node.canonicalUrl);
      if (originalImageUrl) {
        if (
          enqueue(
            crawlRunId,
            originalImageUrl,
            node.canonicalUrl,
            "image-original",
            "image"
          )
        ) {
          discovered++;
          linksDiscoveredTotal++;
        }
      }
      ocrUsed = true;
      const extracted = await extractImageText(fetched.buf);
      const visualAnalysis = await analyzeImageVisualContent(fetched.buf);
      text = extracted.text || "";
      nodeOcrStatus = extracted.status;
      const candidate = detectPolicyCandidate(text, node.canonicalUrl);
      const visuallyNonDocument =
        Boolean(visualAnalysis?.clearlyNonDocumentMedia) &&
        !isPolicyLikeResourceUrl(node.canonicalUrl);
      const safelyDecorativeNoText =
        (extracted.status === "OCR_LOW_CONFIDENCE" ||
          extracted.status === "OCR_EMPTY") &&
        (isClearlyDecorativeImageUrl(node.canonicalUrl) ||
          isClearlyPatientConventionLogoUrl(
            node.canonicalUrl,
            node.parentUrl
          ) ||
          isClearlyCommercialProductImageUrl(
            node.canonicalUrl,
            node.parentUrl
          ) ||
          Boolean(originalImageUrl) ||
          visuallyNonDocument) &&
        !candidate.candidate;
      if (safelyDecorativeNoText) {
        nodeOcrStatus = "OCR_NON_DOCUMENT_MEDIA";
      }
      if (
        extracted.status === "OCR_TIMEOUT" ||
        extracted.status === "OCR_EXTRACTION_FAILED" ||
        ((extracted.status === "OCR_LOW_CONFIDENCE" ||
          extracted.status === "OCR_EMPTY") &&
          !safelyDecorativeNoText)
      ) {
        setCrawlRunFlags(crawlRunId, { ocrDoubts: 1 });
        const retries = (node.retryCount || 0) + 1;
        try {
          if (retries >= budget.maxDocumentRetries) {
            transitionFrontierNode(node.id, "TECHNICAL_BLOCKED", {
              lastError: `IMAGE_${extracted.status}:VISUAL_V9`,
              contentHash: hash,
              bumpRetry: true,
            });
          } else {
            transitionFrontierNode(node.id, "RETRY_PENDING", {
              lastError: `IMAGE_${extracted.status}:VISUAL_V9`,
              contentHash: hash,
              bumpRetry: true,
              nextRetryAt: new Date(Date.now() + computeBackoffMs(retries)).toISOString(),
            });
          }
        } catch {
          /* */
        }
        continue;
      }
    } else if (resourceType === "html") {
      let html = fetched.buf.toString("utf8");
      const renderedNetworkText: Array<{ url: string; text: string }> = [];
      if (renderEveryHtml) {
        heartbeatCrawlRun(crawlRunId, `render:${node.canonicalUrl.slice(0, 80)}`);
        const rendered = await fetchSinglePageViaBrowser(node.canonicalUrl);
        if (!rendered.ok) {
          const retries = (node.retryCount || 0) + 1;
          try {
            if (retries >= budget.maxBrowserRetries) {
              transitionFrontierNode(node.id, "TECHNICAL_BLOCKED", {
                lastError: `BROWSER_RENDER:${rendered.error || rendered.status}`,
                bumpRetry: true,
              });
            } else {
              transitionFrontierNode(node.id, "RETRY_PENDING", {
                lastError: `BROWSER_RENDER:${rendered.error || rendered.status}`,
                bumpRetry: true,
                nextRetryAt: new Date(Date.now() + computeBackoffMs(retries)).toISOString(),
              });
            }
          } catch {
            /* */
          }
          continue;
        }
        html = rendered.html;
        playwrightUsed = true;
        playwrightSource = "rendered";
        try {
          transitionFrontierNode(node.id, "RENDERED");
        } catch {
          /* */
        }
        for (const network of rendered.networkResources) {
          let networkProtocol = "";
          try {
            networkProtocol = new URL(network.url).protocol;
          } catch {
            continue;
          }
          if (networkProtocol !== "http:" && networkProtocol !== "https:") {
            continue;
          }
          const networkType = resourceTypeForContentType(
            network.url,
            network.contentType
          );
          const sameSiteNetwork = isCrawlScopeResource(
            network.url,
            opts.website,
            networkType
          );
          // Third-party widgets may return megabytes of JavaScript/CSS whose
          // identifiers resemble insurers or dates. They are not page text.
          // Same-site API/script bodies remain discoverable with their own URL
          // as the resolution base, so genuine dynamically exposed documents
          // are still enqueued and analysed independently.
          if (network.bodyText && sameSiteNetwork) {
            renderedNetworkText.push({ url: network.url, text: network.bodyText });
          }
          if (
            (network.method !== "GET" && network.method !== "HEAD") ||
            network.status < 200 ||
            network.status >= 400
          ) {
            continue;
          }
          if (
            sameSiteNetwork ||
            shouldFollowExternalResource(network.url, networkType)
          ) {
            if (
              enqueue(
                crawlRunId,
                network.url,
                node.canonicalUrl,
                "playwright-network",
                networkType
              )
            ) {
              discovered++;
            }
          }
        }
      }
      if (htmlSamples.length < 3) htmlSamples.push(html.slice(0, 8000));
      text = extractVisibleTextFromHtml(html);
      for (const networkText of renderedNetworkText) {
        const nLinks = discoverTextResources(
          networkText.text,
          networkText.url,
          opts.website,
          crawlRunId
        );
        discovered += nLinks;
        linksDiscoveredTotal += nLinks;
      }
      if (opts.discoverLinks !== false) {
        const nLinks = discoverLinks(
          html,
          node.canonicalUrl,
          opts.website,
          crawlRunId
        );
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
    } else {
      text = fetched.buf.toString("utf8").replace(/\s+/g, " ").trim();
      if (opts.discoverLinks !== false) {
        const nLinks = discoverTextResources(
          text,
          node.canonicalUrl,
          opts.website,
          crawlRunId
        );
        discovered += nLinks;
        linksDiscoveredTotal += nLinks;
      }
    }

    pagesText = `${pagesText}\n${text}`.slice(0, 200_000);
    const candidate = detectPolicyCandidate(text, node.canonicalUrl);
    const analysis = candidate.policy;
    const currentPolicyText = analysis.policyFound
      ? boundedPolicyEvidenceText(text, analysis.policyNumber, analysis.company)
      : "";
    if (analysis.policyFound) {
      policyFound = true;
      policyUrl = node.canonicalUrl;
      policyText = currentPolicyText;
      contentHash = hash;
    }

    try {
      persistNodeEvidence({
        crawlRunId,
        nodeId: node.id,
        canonicalUrl: node.canonicalUrl,
        contentHash: hash,
        resourceType,
        normalizedText: text,
        policyText: currentPolicyText,
        policyFound: Boolean(analysis.policyFound),
        policyCandidate: candidate.candidate,
        policySignalsJson: {
          ...analysis,
          candidateReasons: candidate.reasons,
          candidateDetectorVersion: candidate.detectorVersion,
        },
        ocrStatus: nodeOcrStatus,
        playwrightSource,
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
  try {
    await (sliceBrowserContext as import("playwright").BrowserContext | null)?.close();
  } catch {
    /* */
  }
  sliceBrowserContext = null;
  try {
    // cast: TS non traccia l'assegnazione dentro la closure fetchSinglePageViaBrowser
    await (sliceBrowser as import("playwright").Browser | null)?.close();
  } catch {
    /* */
  }
  sliceBrowser = null;
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
  const skipPw =
    renderEveryHtml ||
    process.env.SKIP_PLAYWRIGHT === "1" ||
    process.env.REVALIDATE_FINALIZE_RESUME === "1" ||
    listNodes(crawlRunId).filter(
      (n) =>
        (n.relevance === "critical" || n.relevance === "relevant") &&
        ["DISCOVERED", "QUEUED", "FETCHING", "FETCHED", "RENDERED", "PARSED", "RETRY_PENDING"].includes(
          n.state
        )
    ).length === 0;
  if (skipPw) {
    heartbeatCrawlRun(crawlRunId, "playwright_skipped:finalize_or_exhausted");
  } else if (pwDecision.activate && !policyFound && Date.now() < deadline) {
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
  const orphanRetries = countRetryPendingMissingNextRetryAt(crawlRunId);
  if (orphanRetries > 0) {
    repairOrphanRetryPending(crawlRunId);
    const still = countRetryPendingMissingNextRetryAt(crawlRunId);
    if (still > 0) {
      throw new Error(`invariant_retry_pending_null_nextRetryAt count=${still}`);
    }
  }
  const boundedWafRetryLimit =
    budget.maxUrlRetries + Math.max(1, budget.maxBrowserRetries);
  const pendingWork = nodesAfter.some(
    (n) =>
      ["DISCOVERED", "QUEUED", "FETCHING", "RETRY_PENDING"].includes(n.state) ||
      (n.state === "TECHNICAL_BLOCKED" &&
        /^(?:reopen:)*http_(?:403|429)$/i.test(String(n.lastError || "")) &&
        (n.retryCount || 0) < boundedWafRetryLimit)
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
        // preserva diagnosi precedenti (NODE_STALL_WATCHDOG, host_circuit_open, …)
        stopReason = stopReason ?? SLICE_BUDGET_EXHAUSTED;
        settle = "SLICE_CHECKPOINTED";
        heartbeatCrawlRun(crawlRunId, stopReason);
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
  const maxSlices =
    opts.maxSlices ??
    (process.env.CRAWL_REQUIRE_EXHAUSTIVE_SITE === "1"
      ? Math.max(1, Number(process.env.CRAWL_MAX_SLICES_PER_LEAD || 5))
      : 20);
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
