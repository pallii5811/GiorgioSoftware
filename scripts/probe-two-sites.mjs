/**
 * Verifica live sui due casi segnalati dall'utente.
 * npx tsx scripts/probe-two-sites.mjs
 */
import { crawlSite } from "../src/lib/sanita/crawler.ts";
import { analyzeCrawlPolicy, reconcilePolicyVerdict } from "../src/lib/sanita/policy-verify.ts";
import { verdictFromSite } from "../src/lib/sanita/verdict.ts";

const CASES = [
  {
    name: "Casa Di Cura Villa Cinzia",
    website: "https://www.clinicavillacinzia.com",
  },
  {
    name: "Casa Di Cura Villa Maione",
    website: "https://www.villamaione.com",
  },
];

for (const c of CASES) {
  console.log(`\n=== ${c.name} ===`);
  console.log(`URL: ${c.website}`);
  const crawl = await crawlSite(c.website);
  console.log(`crawl ok: ${crawl.ok} | relevant: ${crawl.foundRelevantPage} | pdfs ${crawl.policyPdfsRead}/${crawl.policyPdfsQueued}`);
  if (!crawl.ok) {
    console.log(`errore: ${crawl.error}`);
    continue;
  }
  const analysis = analyzeCrawlPolicy(crawl);
  const prelim = verdictFromSite({
    reachable: true,
    policyFound: analysis.policyFound,
    foundRelevantPage: crawl.foundRelevantPage,
  });
  const rec = reconcilePolicyVerdict(crawl, analysis, prelim, {
    companyName: c.name,
    website: c.website,
    city: null,
    category: "Casa di cura",
  });
  console.log(`verdetto: ${rec.verdict}`);
  console.log(`policyFound: ${analysis.policyFound} | company: ${analysis.company ?? "—"} | mass: ${analysis.massimale ?? "—"} | n: ${analysis.policyNumber ?? "—"} | exp: ${analysis.expiry?.toISOString?.().slice(0, 10) ?? "—"}`);
  console.log(`note: ${rec.note ?? "—"}`);
  const pdfs = crawl.pagesVisited.filter((u) => /\.pdf/i.test(u)).slice(0, 5);
  if (pdfs.length) console.log(`pdf campione: ${pdfs.join(" | ")}`);
}
