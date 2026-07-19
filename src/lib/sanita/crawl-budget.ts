/**
 * Configurable crawl budgets — env-driven, no hardcoded slice deadlines in callers.
 */
function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export type CrawlBudgetConfig = {
  sliceBudgetMs: number;
  runMaxWallClockMs: number;
  httpRequestTimeoutMs: number;
  browserNavigationTimeoutMs: number;
  pdfFetchTimeoutMs: number;
  ocrTimeoutMs: number;
  maxUrlRetries: number;
  maxBrowserRetries: number;
  maxDocumentRetries: number;
  perHostConcurrency: number;
  perHostDelayMs: number;
  maxHtmlPerSlice: number;
};

export function readCrawlBudgetConfig(
  overrides: Partial<CrawlBudgetConfig> = {}
): CrawlBudgetConfig {
  return {
    sliceBudgetMs: overrides.sliceBudgetMs ?? num("CRAWL_SLICE_BUDGET_MS", 90_000),
    runMaxWallClockMs: overrides.runMaxWallClockMs ?? num("CRAWL_RUN_MAX_WALL_CLOCK_MS", 900_000),
    httpRequestTimeoutMs: overrides.httpRequestTimeoutMs ?? num("HTTP_REQUEST_TIMEOUT_MS", 20_000),
    browserNavigationTimeoutMs:
      overrides.browserNavigationTimeoutMs ?? num("BROWSER_NAVIGATION_TIMEOUT_MS", 60_000),
    pdfFetchTimeoutMs: overrides.pdfFetchTimeoutMs ?? num("PDF_FETCH_TIMEOUT_MS", 45_000),
    ocrTimeoutMs: overrides.ocrTimeoutMs ?? num("OCR_TIMEOUT_MS", 90_000),
    maxUrlRetries: overrides.maxUrlRetries ?? num("MAX_URL_RETRIES", 3),
    maxBrowserRetries: overrides.maxBrowserRetries ?? num("MAX_BROWSER_RETRIES", 2),
    maxDocumentRetries: overrides.maxDocumentRetries ?? num("MAX_DOCUMENT_RETRIES", 2),
    perHostConcurrency: overrides.perHostConcurrency ?? num("PER_HOST_CONCURRENCY", 1),
    perHostDelayMs: overrides.perHostDelayMs ?? num("PER_HOST_DELAY_MS", 500),
    maxHtmlPerSlice: overrides.maxHtmlPerSlice ?? num("CRAWL_MAX_HTML_PER_SLICE", 8),
  };
}

export const SLICE_BUDGET_EXHAUSTED = "SLICE_BUDGET_EXHAUSTED";
export const RUN_WALL_CLOCK_EXHAUSTED = "RUN_WALL_CLOCK_EXHAUSTED";
