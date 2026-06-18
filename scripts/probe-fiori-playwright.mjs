process.env.OCR_ENABLED = "1";

import { crawlSite } from "../src/lib/sanita/crawler.ts";
import { enrichCrawlWithPlaywright } from "../src/lib/sanita/policy-playwright.ts";
import { analyzeCrawlPolicy, reconcilePolicyVerdict } from "../src/lib/sanita/policy-verify.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";
import { terminateOcrWorker } from "../src/lib/sanita/ocr.ts";
import { closeMapsBrowserPool } from "../src/lib/sanita/playwright-maps.ts";

const url = "https://www.villadeifioriacerra.it/";
console.log("CRAWL...");
let crawl = await crawlSite(url);
console.log("pages", crawl.pagesVisited.length, "pdfs", crawl.policyPdfsRead, "/", crawl.policyPdfsQueued);
console.log("pdfUrls visited", crawl.pagesVisited.filter((u) => /\.pdf/i.test(u)));
console.log("policyPdfUrl", crawl.policyPdfUrl);
console.log("policyFound crawl", crawl.policyPdfAnalysis?.policyFound);

console.log("PLAYWRIGHT...");
crawl = await enrichCrawlWithPlaywright(url, crawl);
console.log("after pw pages", crawl.pagesVisited.length, "pdfs", crawl.policyPdfsRead);
console.log("pdfUrls", crawl.pagesVisited.filter((u) => /\.pdf/i.test(u)));
console.log("policyPdfUrl", crawl.policyPdfUrl);
console.log("policyPdfAnalysis", crawl.policyPdfAnalysis);

const analysis = analyzeCrawlPolicy(crawl);
const rec = reconcilePolicyVerdict(crawl, analysis, "REVIEW", {
  companyName: "Casa di Cura Privata Villa dei Fiori Pronto Soccorso",
  website: url,
  city: "Acerra",
  mapsVerified: true,
});
console.log("VERDICT", rec.verdict, readVerdictToken(rec.note));
console.log("company", rec.analysis.company);

await terminateOcrWorker().catch(() => {});
await closeMapsBrowserPool().catch(() => {});
