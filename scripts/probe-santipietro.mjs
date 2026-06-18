process.env.POLICY_EXHAUSTIVE = "1";
process.env.OCR_ENABLED = "0";

import { crawlSite } from "../src/lib/sanita/crawler.ts";
import { analyzeCrawlPolicy, reconcilePolicyVerdict } from "../src/lib/sanita/policy-verify.ts";

const url = "https://www.cmsantipietroepaolo.it/";
const crawl = await crawlSite(url);
console.log("ok:", crawl.ok);
console.log("foundRelevantPage:", crawl.foundRelevantPage);
console.log("policyExhaustive:", crawl.policyExhaustive);
console.log("pagesVisited:", crawl.pagesVisited);
console.log("policyText:", crawl.policyText?.slice(0, 300));
console.log("text:", crawl.text?.slice(0, 300));

const rec = reconcilePolicyVerdict(crawl, analyzeCrawlPolicy(crawl), "REVIEW", {
  companyName: "Santi Pietro E Paolo Centro Medico",
  website: url,
  city: "Agropoli",
});
console.log("verdict:", rec.verdict);
console.log("note:", rec.note);
