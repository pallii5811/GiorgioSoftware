import { enrichCrawlWithPlaywright } from "../src/lib/sanita/policy-playwright.ts";
import { analyzeCrawlPolicy, reconcilePolicyVerdict } from "../src/lib/sanita/policy-verify.ts";

const baseUrl = "https://www.casadicuravillaigea.it/";
const mock = {
  ok: true,
  text: "Prenota online",
  policyText: "Prenota onlineOpen main menuPrenota online",
  pagesVisited: [baseUrl, `${baseUrl}sito/amministrazione-trasparente`],
  foundRelevantPage: false,
  policyExhaustive: true,
  policyPdfsRead: 5,
  policyPdfsQueued: 8,
  needsOcrReview: false,
  policyPdfAnalysis: null,
  policyPdfUrl: null,
  error: null,
  emails: [],
  phones: [],
  pec: null,
  piva: null,
};

console.log("enriching with Playwright...");
const crawl = await enrichCrawlWithPlaywright(baseUrl, mock);
const analysis = analyzeCrawlPolicy(crawl);
const rec = reconcilePolicyVerdict(crawl, analysis, "REVIEW", {
  companyName: "Casa di Cura Villa Igea",
  website: baseUrl,
  city: "Napoli",
  mapsVerified: true,
});
console.log(
  JSON.stringify(
    {
      policyFound: analysis.policyFound,
      company: analysis.company,
      policyNumber: analysis.policyNumber,
      massimale: analysis.massimale,
      verdict: rec.verdict,
      note: rec.note,
      policyTextSnippet: crawl.policyText?.match(/polizza[\s\S]{0,180}/i)?.[0],
    },
    null,
    2
  )
);
