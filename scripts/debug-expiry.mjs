/** Verifica estrazione scadenza sui siti PUBLISHED reali. */
process.env.OCR_ENABLED = "1";
process.env.POLICY_EXHAUSTIVE = "1";
import { crawlSite } from "../src/lib/sanita/crawler.ts";
import { analyzeCrawlPolicy } from "../src/lib/sanita/policy-verify.ts";

const url = process.argv[2] ?? "https://clinicavillafiorita.it/";
console.log(`Crawl ${url}…`);
const crawl = await crawlSite(url);
console.log(`pagine=${crawl.pagesVisited.length} pdfQueued=${crawl.policyPdfsQueued} pdfRead=${crawl.policyPdfsRead}`);
const text = crawl.policyText || "";
console.log(`policyText len=${text.length}`);
const a = analyzeCrawlPolicy(crawl);
console.log({
  policyFound: a.policyFound,
  company: a.company,
  massimale: a.massimale,
  expiry: a.expiry,
  policyNumber: a.policyNumber,
  confidence: a.confidence,
});
// Mostra le righe attorno a date trovate nel testo
const dates = [...text.matchAll(/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/g)].slice(0, 20);
for (const m of dates) {
  const i = m.index ?? 0;
  console.log(`  …${text.slice(Math.max(0, i - 80), i + 30).replace(/\s+/g, " ")}…`);
}
process.exit(0);
