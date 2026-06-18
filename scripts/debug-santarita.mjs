import { crawlSite } from "../src/lib/sanita/crawler.ts";
import { analyzePolicy } from "../src/lib/sanita/detector.ts";
import { reconcilePolicyVerdict } from "../src/lib/sanita/policy-verify.ts";

const url = "https://www.clinicasantarita.eu/";

console.log("=== TEST: clinicasantarita.eu ===");
const crawl = await crawlSite(url);
console.log("ok:", crawl.ok);
console.log("pages:", crawl.pagesVisited.length);
console.log("foundRelevant:", crawl.foundRelevantPage);
console.log("policyExhaustive:", crawl.policyExhaustive);
console.log("pdfUrl:", crawl.policyPdfUrl);
console.log("pdfsQueued:", crawl.policyPdfsQueued);
console.log("pdfsRead:", crawl.policyPdfsRead);
console.log("policyText length:", (crawl.policyText || "").length);
console.log("text length:", (crawl.text || "").length);

// Cerco "AM TRUST" nel testo
const combined = `${crawl.text} ${crawl.policyText}`;
const hasAmTrust = /am\s*trust/i.test(combined);
const hasPolizza = /polizza\s+n/i.test(combined);
const hasMassimale = /30\.000\.000/i.test(combined);
const hasRCI = /RCI\s*000/i.test(combined);
console.log("\n--- KEYWORD CHECK ---");
console.log("AM TRUST found:", hasAmTrust);
console.log("Polizza n. found:", hasPolizza);
console.log("30.000.000 found:", hasMassimale);
console.log("RCI 000 found:", hasRCI);

if (!hasAmTrust) {
  // Mostra un sample del testo per capire cosa vede il crawler
  console.log("\n--- TEXT SAMPLE (first 2000 chars) ---");
  console.log(combined.slice(0, 2000));
  console.log("\n--- TEXT SAMPLE (last 2000 chars) ---");
  console.log(combined.slice(-2000));
}

const a = analyzePolicy(crawl.policyText || crawl.text || "");
console.log("\n--- DETECTOR ---");
console.log("policyFound:", a.policyFound);
console.log("company:", a.company);
console.log("massimale:", a.massimale);
console.log("policyNumber:", a.policyNumber);

const r = reconcilePolicyVerdict(crawl, a, "REVIEW", {
  companyName: "Casa di Cura Santa Rita",
  website: url,
  city: "Atripalda",
});
console.log("\n=== VERDICT:", r.verdict, "===");
console.log("reason:", r.reason);
