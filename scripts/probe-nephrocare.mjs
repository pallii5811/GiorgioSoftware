process.env.OCR_ENABLED = "0";
process.env.POLICY_EXHAUSTIVE = "1";

import { crawlSite } from "../src/lib/sanita/crawler.ts";
import { analyzeCrawlPolicy, reconcilePolicyVerdict } from "../src/lib/sanita/policy-verify.ts";

const url = "https://www.nephrocare.com";
const crawl = await crawlSite(url);
console.log("ok:", crawl.ok);
console.log("foundRelevantPage:", crawl.foundRelevantPage);
console.log("policyExhaustive:", crawl.policyExhaustive);
console.log("pagesVisited:", crawl.pagesVisited);
console.log("policyPdfUrl:", crawl.policyPdfUrl);
console.log("policyText sample:", crawl.policyText?.slice(0, 500));

const analysis = analyzeCrawlPolicy(crawl);
console.log("analysis:", JSON.stringify(analysis, null, 2));

const rec = reconcilePolicyVerdict(crawl, analysis, "REVIEW", {
  companyName: "NephroCare",
  website: url,
  city: "Napoli",
});
console.log("verdict:", rec.verdict, rec.note);
