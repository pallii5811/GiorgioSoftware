import * as cheerio from "cheerio";
import { externalFetch } from "../src/lib/http.ts";
import { pageCountsAsPolicyRelevant } from "../src/lib/sanita/crawler.ts";
import { analyzePolicy } from "../src/lib/sanita/detector.ts";
import { needsPlaywrightPolicyPass } from "../src/lib/sanita/policy-playwright.ts";
import { analyzeCrawlPolicy, reconcilePolicyVerdict } from "../src/lib/sanita/policy-verify.ts";

const url = "https://www.casadicuravillaigea.it/sito/amministrazione-trasparente";

function extractText(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe").remove();
  return $("body").text().replace(/\s+/g, " ").trim();
}

const html = await (await externalFetch(url, { timeoutMs: 30000 })).text();
const text = extractText(html);
console.log("extractText chars:", text.length);
console.log("pageRelevant:", pageCountsAsPolicyRelevant(url, text));
console.log("policyFound:", analyzePolicy(text).policyFound);
console.log("snippet:", text.slice(0, 300));

const mock = {
  ok: true,
  text,
  policyText: text,
  pagesVisited: [url, "https://www.casadicuravillaigea.it/"],
  foundRelevantPage: pageCountsAsPolicyRelevant(url, text),
  policyExhaustive: true,
  policyPdfsRead: 5,
  policyPdfsQueued: 8,
  needsOcrReview: false,
  policyPdfAnalysis: null,
  policyPdfUrl: null,
};
console.log("needsPlaywright:", needsPlaywrightPolicyPass(mock));
const analysis = analyzeCrawlPolicy(mock);
const rec = reconcilePolicyVerdict(mock, analysis, "REVIEW", {
  companyName: "Casa di Cura Villa Igea",
  website: "https://www.casadicuravillaigea.it/",
  city: "Napoli",
  mapsVerified: true,
});
console.log("verdict without PW:", rec.verdict, rec.note);
