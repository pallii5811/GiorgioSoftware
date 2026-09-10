import { reconcilePolicyVerdict, analyzeCrawlPolicy } from "@/lib/sanita/policy-verify";
// @ts-check

function mkCrawl(text, policyPdfUrl) {
  return {
    text,
    policyText: text,
    pagesVisited: [policyPdfUrl],
    ok: true,
    error: null,
    foundRelevantPage: false,
    policyExhaustive: true,
    policyPdfsQueued: 1,
    policyPdfsRead: 1,
    needsOcrReview: false,
    policyPdfAnalysis: null,
    policyPdfUrl,
    emails: [],
    pec: null,
    phones: [],
    piva: null,
    completeness: {
      complete: true,
      unresolvedRelevantUrls: 0,
      failedRelevantUrls: 0,
      unreadableRelevantDocuments: 0,
      criticalOcrDoubts: 0,
      sitemapStatus: "ok",
      urlCapReached: false,
      timeCapReached: false,
    },
  };
}

const text =
  "La società Casa di Cura Privata Montevergine S.p.A rende noto di essere provvista di copertura assicurativa RCT/O in virtù del contratto di polizza N 450289527 stipulato con la compagnia assicurativa Generali Italia S.p.A. con validità 20/04/2025 – 20/04/2026";
const crawl = mkCrawl(
  text,
  "https://www.clinicamontevergine.com/cuore/wp-content/uploads/2025/06/OBBLIGO-DI-ASSICURAZIONE.pdf"
);
const analysis = analyzeCrawlPolicy(crawl);
const rec = reconcilePolicyVerdict(crawl, analysis, "PUBLISHED", {
  website: "http://www.clinicamontevergine.com/",
  companyName: "Casa Di Cura Montevergine",
  city: "Solofra",
  category: "Ospedale",
  osmId: null,
  mapsVerified: false,
});
console.log("analysis", JSON.stringify(analysis, null, 1));
console.log("reconcile", JSON.stringify(rec, null, 1));
