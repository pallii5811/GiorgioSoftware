/**
 * Secondo passaggio con browser reale — siti con Trasparenza in JavaScript/accordion
 * (es. pinetagrande.it/documenti) non espongono il testo a fetch statico.
 */
import * as cheerio from "cheerio";
import type { CrawlResult } from "@/lib/sanita/crawler";
import { analyzePolicy } from "@/lib/sanita/detector";

const POLICY_PATH =
  /trasparen|documenti|amministrazione|polizz|assicuraz|gelli|responsabilit|societa-trasparente/i;

const PROBE_PATHS = [
  "/documenti",
  "/amministrazione-trasparente",
  "/societa-trasparente",
  "/trasparenza",
  "/it/amministrazione-trasparente",
];

function extractText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe").remove();
  return $("body").text().replace(/\s+/g, " ").trim();
}

function pdfsFromHtml(html: string, base: string): string[] {
  const $ = cheerio.load(html);
  const out: string[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (!/\.pdf(?:$|\?|#)/i.test(href)) return;
    try {
      const u = new URL(href, base);
      if (u.protocol === "https:" || u.protocol === "http:") out.push(u.toString());
    } catch {
      /* skip */
    }
  });
  return out;
}

/** Serve un secondo passaggio Playwright? */
export function needsPlaywrightPolicyPass(crawl: CrawlResult): boolean {
  if (!crawl.ok) return false;
  if (crawl.policyExhaustive && crawl.foundRelevantPage) return false;
  const visitedPolicyish = crawl.pagesVisited.some((u) => POLICY_PATH.test(u));
  return (
    !crawl.foundRelevantPage ||
    !crawl.policyExhaustive ||
    visitedPolicyish ||
    crawl.pagesVisited.length <= 4
  );
}

/** Arricchisce il crawl con HTML renderizzato + link PDF da pagine Trasparenza. */
export async function enrichCrawlWithPlaywright(
  baseUrl: string,
  crawl: CrawlResult
): Promise<CrawlResult> {
  if (!needsPlaywrightPolicyPass(crawl)) return crawl;

  const { launchMapsBrowser } = await import("@/lib/sanita/playwright-maps");
  const { browser, context, page } = await launchMapsBrowser();
  const extraPages: string[] = [];
  let combined = crawl.text;
  let policyText = crawl.policyText;
  let foundRelevantPage = crawl.foundRelevantPage;
  const pdfUrls = new Set<string>();

  try {
    const urls = new Set<string>();
    for (const p of crawl.pagesVisited) {
      if (POLICY_PATH.test(p)) urls.add(p);
    }
    for (const path of PROBE_PATHS) {
      try {
        urls.add(new URL(path, baseUrl).toString());
      } catch {
        /* skip */
      }
    }
    urls.add(baseUrl);

    for (const url of urls) {
      try {
        await page
          .goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 })
          .catch(() => {});
        await page.waitForTimeout(2000);
        const html = await page.content();
        const text = extractText(html);
        if (!text || text.length < 30) continue;

        extraPages.push(url);
        combined = `${combined} \n ${text}`.slice(0, 64_000);

        const relevant =
          POLICY_PATH.test(url) || /trasparen|polizz|assicuraz|gelli|art\.?\s*10/i.test(text);
        if (relevant) {
          foundRelevantPage = true;
          policyText = policyText ? `${policyText} \n ${text}` : text;
          for (const pdf of pdfsFromHtml(html, url)) pdfUrls.add(pdf);
        }
      } catch {
        /* pagina singola */
      }
    }
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  if (extraPages.length === 0 && pdfUrls.size === 0) return crawl;

  // Leggi PDF trovati via browser (import lazy dal crawler)
  const { fetchPdfTextWithRetry } = await import("@/lib/sanita/crawler");
  let policyPdfsRead = crawl.policyPdfsRead;
  let policyPdfsQueued = crawl.policyPdfsQueued + pdfUrls.size;
  let needsOcrReview = crawl.needsOcrReview;
  let policyPdfAnalysis = crawl.policyPdfAnalysis;

  for (const pdfUrl of pdfUrls) {
    const { text, needsOcr } = await fetchPdfTextWithRetry(pdfUrl, { forceOcr: true });
    policyPdfsRead++;
    extraPages.push(pdfUrl);
    if (needsOcr && !text?.trim()) needsOcrReview = true;
    if (!text?.trim()) continue;
    policyText = policyText ? `${policyText} \n ${text}` : text;
    foundRelevantPage = true;
    const a = analyzePolicy(text);
    if (a.policyFound) {
      policyPdfAnalysis = a;
      break;
    }
  }

  const allPdfsRead = policyPdfsQueued === 0 || policyPdfsRead >= policyPdfsQueued;
  const policyExhaustive =
    !!policyPdfAnalysis?.policyFound ||
    (allPdfsRead &&
      !needsOcrReview &&
      foundRelevantPage &&
      (policyText.trim().length >= 120 || policyPdfsQueued > 0));

  return {
    ...crawl,
    text: combined,
    policyText,
    pagesVisited: [...crawl.pagesVisited, ...extraPages.filter((p) => !crawl.pagesVisited.includes(p))],
    foundRelevantPage,
    policyExhaustive,
    policyPdfsQueued,
    policyPdfsRead,
    needsOcrReview,
    policyPdfAnalysis,
  };
}
