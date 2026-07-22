import * as cheerio from "cheerio";
import type { CrawlResult } from "@/lib/sanita/crawler";
import {
  pageCountsAsPolicyRelevant,
  transparencyCrawlComplete,
} from "@/lib/sanita/crawler";
import { extractPageText } from "@/lib/sanita/extract-embedded";
import { analyzePolicy, isGelliComplianceReportOnly } from "@/lib/sanita/detector";
import { isParkedOrForSalePage, isSiteUnderMaintenance } from "@/lib/sanita/website";
import { PLAYWRIGHT_POLICY_MAX_MS, PLAYWRIGHT_POLICY_MAX_URLS } from "@/lib/sanita/scan-config";

/** Budget a call-time (k3 RC-05): la const di scan-config è congelata all'import,
 *  quindi l'override per-slice via env non funzionava. Leggere sempre qui. */
function policyMaxMs(): number {
  const n = Number(process.env.PLAYWRIGHT_POLICY_MAX_MS || 0);
  return Number.isFinite(n) && n > 0 ? n : PLAYWRIGHT_POLICY_MAX_MS;
}
/** Timeout navigazione granulare — rispetta BROWSER_NAVIGATION_TIMEOUT_MS. */
function navTimeoutMs(): number {
  const n = Number(process.env.BROWSER_NAVIGATION_TIMEOUT_MS || 0);
  return Number.isFinite(n) && n >= 1000 ? n : 60_000;
}

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
  "/assicurazione-rct",
  "/assicurazione-rct/",
  "/assicurazione-rct-professionale",
];

function extractText(html: string): string {
  return extractPageText(html);
}

function sameHostUrl(baseUrl: string, href: string): string | null {
  try {
    const base = new URL(baseUrl);
    const u = new URL(href, baseUrl);
    if (u.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) return null;
    if (!/^https?:$/.test(u.protocol)) return null;
    if (/\.(?:css|js|woff2?|png|jpe?g|gif|svg|zip)(?:$|\?|#)/i.test(u.pathname)) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function linksFromHtml(html: string, pageUrl: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const out: string[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (!href || href.startsWith("#") || /^mailto:|^tel:/i.test(href)) return;
    const abs = sameHostUrl(baseUrl, href);
    if (!abs || seen.has(abs)) return;
    seen.add(abs);
    out.push(abs);
  });
  return out;
}

function linkPriority(url: string, anchorText = ""): number {
  const hay = `${url} ${anchorText}`.toLowerCase();
  if (/amministrazione-trasparente|societa-trasparente|area-trasparenza/.test(hay)) return 100;
  if (/polizz|assicuraz|\brct\b|gelli|responsabilit/.test(hay)) return 90;
  if (/trasparen|documenti|note-legali|legal/.test(hay)) return 70;
  if (/\.pdf(?:$|\?|#)/i.test(hay)) return 60;
  return 0;
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
  // Fetch HTTP fallito (403 WAF datacenter, timeout): il browser reale può ancora entrare.
  if (!crawl.ok) return true;
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
  crawl: CrawlResult,
  opts?: { surfaceErrors?: boolean }
): Promise<CrawlResult> {
  if (!needsPlaywrightPolicyPass(crawl)) return crawl;
  const maxMs = policyMaxMs();
  let aborted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (maxMs > 0) {
    timer = setTimeout(() => {
      aborted = true;
    }, maxMs);
  }
  try {
    const result = await enrichCrawlWithPlaywrightInner(baseUrl, crawl, () => aborted);
    if (aborted && !result.policyPdfAnalysis?.policyFound) return crawl;
    return result;
  } catch (e) {
    if (opts?.surfaceErrors) throw e;
    return {
      ...crawl,
      error: crawl.error || (e instanceof Error ? e.message : String(e)),
    };
  } finally {
    if (timer) clearTimeout(timer);
    aborted = true;
  }
}

async function enrichCrawlWithPlaywrightInner(
  baseUrl: string,
  crawl: CrawlResult,
  isAborted: () => boolean = () => false
): Promise<CrawlResult> {
  if (!needsPlaywrightPolicyPass(crawl)) return crawl;

  const { launchMapsBrowser } = await import("@/lib/sanita/playwright-maps");
  const { browser, context, page } = await launchMapsBrowser();
  const extraPages: string[] = [];
  const jsonEndpoints: string[] = [];
  let combined = crawl.text;
  let policyText = crawl.policyText;
  let foundRelevantPage = crawl.foundRelevantPage;
  const pdfUrls = new Set<string>();

  try {
    const baseHost = new URL(baseUrl).hostname.replace(/^www\./, "");
    page.on("response", (res) => {
      try {
        const u = res.url();
        const ct = (res.headers()["content-type"] || "").toLowerCase();
        const host = new URL(u).hostname.replace(/^www\./, "");
        if (host !== baseHost) return;
        if (
          ct.includes("application/json") ||
          /\.json(?:$|\?)/i.test(u) ||
          /\/api\//i.test(u)
        ) {
          if (!jsonEndpoints.includes(u)) jsonEndpoints.push(u);
        }
      } catch {
        /* */
      }
    });

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

    /** Footer/menu WordPress: link «Assicurazione RCT», «Trasparenza» spesso solo nel DOM renderizzato. */
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: navTimeoutMs() }).catch(() => {});
      await page.waitForTimeout(2_500);
      const footerHrefs = await page.evaluate(() => {
        const roots = [
          ...document.querySelectorAll("footer, .footer, #footer, [role='contentinfo']"),
          document.body,
        ];
        const out: string[] = [];
        const seen = new Set<string>();
        for (const root of roots) {
          if (!root) continue;
          for (const a of root.querySelectorAll("a[href]")) {
            const href = (a as HTMLAnchorElement).href;
            const text = (a.textContent || "").replace(/\s+/g, " ").trim();
            const hay = `${href} ${text}`.toLowerCase();
            if (!/assicur|trasparen|polizza|\brct\b|gelli|amministrazione-trasparente|societa-trasparente|\.pdf/i.test(hay))
              continue;
            if (href && !seen.has(href)) {
              seen.add(href);
              out.push(href);
            }
          }
        }
        return out;
      });
      for (const href of footerHrefs) urls.add(href);
    } catch {
      /* footer opzionale */
    }

    const urlCap =
      PLAYWRIGHT_POLICY_MAX_URLS > 0 ? PLAYWRIGHT_POLICY_MAX_URLS : Number.MAX_SAFE_INTEGER;
    const urlList = [...urls].slice(0, urlCap);
    const maxPages = !crawl.ok ? urlCap : urlList.length;
    const visited = new Set<string>(crawl.pagesVisited);
    const htmlQueue: { url: string; pri: number }[] = [];
    const enqueue = (u: string, pri = 0) => {
      if (visited.has(u) || visited.size >= maxPages) return;
      const existing = htmlQueue.find((q) => q.url === u);
      if (existing) {
        if (pri > existing.pri) existing.pri = pri;
        return;
      }
      htmlQueue.push({ url: u, pri });
      htmlQueue.sort((a, b) => b.pri - a.pri);
    };
    for (const u of urlList) enqueue(u, linkPriority(u));

    while (htmlQueue.length > 0 && visited.size < maxPages && !isAborted()) {
      const { url } = htmlQueue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);
      try {
        await page
          .goto(url, { waitUntil: "domcontentloaded", timeout: navTimeoutMs() })
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
        if (isSiteUnderMaintenance(text)) continue;

        extraPages.push(url);
        combined = `${combined} \n ${text}`.slice(0, 64_000);

        const policyOnPage =
          pageCountsAsPolicyRelevant(url, text) ||
          (POLICY_PATH.test(url) && analyzePolicy(text).policyFound);

        // Trasparenza: raccogli PDF solo se la pagina ha contenuto istituzionale reale.
        if (POLICY_PATH.test(url) && !isSiteUnderMaintenance(text)) {
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

        for (const link of linksFromHtml(html, url, baseUrl)) {
          enqueue(link, linkPriority(link));
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

  if (extraPages.length === 0 && pdfUrls.size === 0 && jsonEndpoints.length === 0) return crawl;

  if (isAborted()) return crawl;

  // Leggi PDF trovati via browser (import lazy dal crawler)
  const { fetchPdfTextWithRetry, sortPdfQueue } = await import("@/lib/sanita/crawler");
  const { deriveCrawlComplete } = await import("@/lib/evidence/contract");
  const MAX_PLAYWRIGHT_PDFS = Number.MAX_SAFE_INTEGER;
  let policyPdfsRead = crawl.policyPdfsRead;
  const policyPdfsQueued = crawl.policyPdfsQueued + pdfUrls.size;
  let needsOcrReview = crawl.needsOcrReview;
  let policyPdfAnalysis = crawl.policyPdfAnalysis;
  let policyPdfUrl = crawl.policyPdfUrl;

  for (const pdfUrl of sortPdfQueue(pdfUrls).slice(0, MAX_PLAYWRIGHT_PDFS)) {
    if (isAborted()) break;
    const policyish =
      /trasparen|polizz|assicur|amministraz|gelli|rischio|rc[to]\b|parm|pars|massimale|copertura/i.test(
        pdfUrl
      );
    const { text, needsOcr } = await fetchPdfTextWithRetry(pdfUrl, { forceOcr: policyish });
    policyPdfsRead++;
    extraPages.push(pdfUrl);
    if (needsOcr && !text?.trim() && policyish) needsOcrReview = true;
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

  const gotContent = extraPages.length > 0 || jsonEndpoints.length > 0;
  const allPdfsRead = policyPdfsQueued === 0 || policyPdfsRead >= policyPdfsQueued;
  const mergedVisited = [
    ...crawl.pagesVisited,
    ...extraPages.filter((p) => !crawl.pagesVisited.includes(p)),
    ...jsonEndpoints.filter((p) => !crawl.pagesVisited.includes(p) && !extraPages.includes(p)),
  ];
  const htmlPageCount = mergedVisited.filter((u) => !/\.pdf(?:$|\?|#)/i.test(u)).length;
  const bfsComplete = htmlPageCount >= 12 || (!crawl.ok && gotContent && htmlPageCount >= 5);
  const policyExhaustive =
    !!policyPdfAnalysis?.policyFound ||
    transparencyCrawlComplete({
      pagesVisited: mergedVisited,
      foundRelevantPage,
      policyPdfsQueued,
      policyPdfsRead,
      needsOcrReview,
    }) ||
    (allPdfsRead && !needsOcrReview && policyPdfsQueued > 0) ||
    (bfsComplete && allPdfsRead && !needsOcrReview);

  return {
    ...crawl,
    ok: gotContent || crawl.ok,
    error: gotContent ? null : crawl.error,
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
    completeness: crawl.completeness
      ? deriveCrawlComplete({
          ...crawl.completeness,
          sitemapStatus: crawl.completeness.sitemapStatus ?? "NOT_DISCOVERED",
          relevantDocumentsProcessed: allPdfsRead && !needsOcrReview,
          unreadableRelevantDocuments: needsOcrReview ? 1 : 0,
          criticalOcrDoubts: needsOcrReview ? 1 : 0,
        })
      : crawl.completeness,
  };
}
