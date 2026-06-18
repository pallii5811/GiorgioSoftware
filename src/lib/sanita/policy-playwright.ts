import * as cheerio from "cheerio";
import type { CrawlResult } from "@/lib/sanita/crawler";
import {
  pageCountsAsPolicyRelevant,
  transparencyCrawlComplete,
} from "@/lib/sanita/crawler";
import { extractPageText } from "@/lib/sanita/extract-embedded";
import { analyzePolicy, isGelliComplianceReportOnly } from "@/lib/sanita/detector";
import { isParkedOrForSalePage } from "@/lib/sanita/website";

const POLICY_PATH =
  /trasparen|documenti|amministrazione|polizz|assicuraz|gelli|responsabilit|societa-trasparente|note-legali|legal/i;

const PROBE_PATHS = [
  "/note-legali",
  "/note-legali/",
  "/it-it/note-legali",
  "/it-it/note-legali/",
  "/it/note-legali",
  "/documenti",
  "/amministrazione-trasparente",
  "/sito/amministrazione-trasparente",
  "/societa-trasparente",
  "/trasparenza",
  "/it/amministrazione-trasparente",
];

function extractText(html: string): string {
  return extractPageText(html);
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

/** Trasparenza visitata ma corpo pagina vuoto (Next.js / SPA senza SSR). */
function transparencyPageUnrendered(crawl: CrawlResult): boolean {
  const visitedTransparency = crawl.pagesVisited.some((u) =>
    /amministrazione-trasparente|societa-trasparente|\/trasparen/i.test(u)
  );
  if (!visitedTransparency) return false;
  const pt = crawl.policyText?.trim() || "";
  if (pt.length < 120) return true;
  return !/polizza|responsabilit[aà]\s+civile|assicuraz|massimale|art\.?\s*10|legge\s+gelli/i.test(
    pt
  );
}

/** Serve un secondo passaggio Playwright? */
export function needsPlaywrightPolicyPass(crawl: CrawlResult): boolean {
  if (!crawl.ok) return false;
  if (crawl.policyPdfAnalysis?.policyFound) return false;
  const pt = crawl.policyText?.trim() || "";
  if (pt.length >= 80 && analyzePolicy(pt).policyFound) return false;
  if (analyzePolicy(crawl.text || "").policyFound) return false;

  // SPA o siti con polizza in pagine non-SSR: Playwright su tutto il dominio.
  if (transparencyPageUnrendered(crawl)) return true;
  if (!crawl.foundRelevantPage) return true;
  if (!crawl.policyExhaustive) return true;
  return false;
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
        await Promise.race([
          page
            .waitForFunction(
              () => /polizza|responsabilit[aà]\s+civile|assicurativ/i.test(document.body?.innerText || ""),
              { timeout: 12_000 }
            )
            .catch(() => {}),
          page.waitForTimeout(5_000),
        ]);
        if (POLICY_PATH.test(url)) {
          for (const sel of [
            "text=/copertura assicurativa/i",
            "text=/risk management/i",
            "text=/PARS/i",
            "text=/PARM/i",
            "text=/autoassicuraz/i",
            ".accordion-button",
            ".elementor-tab-title",
            "summary",
            "[data-toggle='collapse']",
            "[aria-expanded='false']",
          ]) {
            const loc = page.locator(sel);
            const n = Math.min(await loc.count().catch(() => 0), 14);
            for (let i = 0; i < n; i++) {
              await loc.nth(i).click({ timeout: 2000 }).catch(() => {});
            }
          }
          await page.waitForTimeout(800);
        }
        const html = await page.content();
        if (isParkedOrForSalePage(html, url)) continue;
        const innerText = await page
          .evaluate(() => document.body?.innerText?.replace(/\s+/g, " ").trim() ?? "")
          .catch(() => "");
        const text = innerText.length >= 30 ? innerText : extractText(html);
        if (!text || text.length < 30) continue;

        extraPages.push(url);
        combined = `${combined} \n ${text}`.slice(0, 64_000);

        const policyOnPage =
          pageCountsAsPolicyRelevant(url, text) ||
          (POLICY_PATH.test(url) && analyzePolicy(text).policyFound);

        // Trasparenza: raccogli TUTTI i PDF (PARM/PARS spesso senza testo RC in pagina).
        if (POLICY_PATH.test(url)) {
          foundRelevantPage = true;
          for (const pdf of pdfsFromHtml(html, url)) pdfUrls.add(pdf);
        }
        if (policyOnPage) {
          foundRelevantPage = true;
          policyText = policyText ? `${policyText} \n ${text}` : text;
          if (!POLICY_PATH.test(url)) {
            for (const pdf of pdfsFromHtml(html, url)) pdfUrls.add(pdf);
          }
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
  const { fetchPdfTextWithRetry, sortPdfQueue } = await import("@/lib/sanita/crawler");
  const MAX_PLAYWRIGHT_PDFS = Number.MAX_SAFE_INTEGER;
  let policyPdfsRead = crawl.policyPdfsRead;
  let policyPdfsQueued = crawl.policyPdfsQueued + pdfUrls.size;
  let needsOcrReview = crawl.needsOcrReview;
  let policyPdfAnalysis = crawl.policyPdfAnalysis;
  let policyPdfUrl = crawl.policyPdfUrl;

  for (const pdfUrl of sortPdfQueue(pdfUrls).slice(0, MAX_PLAYWRIGHT_PDFS)) {
    const { text, needsOcr } = await fetchPdfTextWithRetry(pdfUrl, { forceOcr: true });
    policyPdfsRead++;
    extraPages.push(pdfUrl);
    if (needsOcr && !text?.trim()) needsOcrReview = true;
    if (!text?.trim()) continue;
    policyText = policyText ? `${policyText} \n ${text}` : text;
    foundRelevantPage = true;
    const a = analyzePolicy(text);
    const selfInsuredDoc =
      /autoassicuraz|gestione\s+diretta|ritenzione\s+del\s+rischio/i.test(text) &&
      !/costi\s+contabilizzat|accantonamento\s+fondo\s+risch/i.test(text);
    if (a.policyFound || (selfInsuredDoc && !isGelliComplianceReportOnly(text, pdfUrl))) {
      policyPdfAnalysis = a;
      policyPdfUrl = pdfUrl;
      break;
    }
  }

  const allPdfsRead = policyPdfsQueued === 0 || policyPdfsRead >= policyPdfsQueued;
  const mergedVisited = [
    ...crawl.pagesVisited,
    ...extraPages.filter((p) => !crawl.pagesVisited.includes(p)),
  ];
  const policyExhaustive =
    !!policyPdfAnalysis?.policyFound ||
    transparencyCrawlComplete({
      pagesVisited: mergedVisited,
      foundRelevantPage,
      policyPdfsQueued,
      policyPdfsRead,
      needsOcrReview,
    }) ||
    (allPdfsRead && !needsOcrReview && policyPdfsQueued > 0);

  return {
    ...crawl,
    text: combined,
    policyText,
    pagesVisited: mergedVisited,
    foundRelevantPage,
    policyExhaustive,
    policyPdfsQueued,
    policyPdfsRead,
    needsOcrReview,
    policyPdfAnalysis,
    policyPdfUrl,
  };
}
