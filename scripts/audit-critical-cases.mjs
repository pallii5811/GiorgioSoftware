/** Verifica manuale casi critici — ri-crawl + dettaglio gate */
import { crawlSite } from "../src/lib/sanita/crawler.ts";
import { analyzeCrawlPolicy, reconcilePolicyVerdict } from "../src/lib/sanita/policy-verify.ts";
import { verdictFromSite } from "../src/lib/sanita/verdict.ts";

const CASES = [
  { name: "Buon Samaritano (fapc.it)", company: "Casa del Buon Samaritano", city: "Agropoli", website: "https://www.fapc.it/" },
  { name: "LILT Avellino", company: "LILT - Sezione di Avellino", city: "Avellino", website: "https://www.liltavellino.it/" },
  { name: "Pineta Grande", company: "Pineta Grande Hospital", city: "Castel Volturno", website: "https://www.pinetagrande.it/" },
  { name: "Santa Rita", company: "Casa di Cura Santa Rita", city: "Atripalda", website: "https://www.clinicasantarita.eu/" },
  { name: "Sereniorizzonti", company: "Centro Servizi Residenziali", city: "Marcon", website: "https://www.sereniorizzonti.it/" },
  { name: "Villa Dei Pini", company: "Villa Dei Pini", city: "Avellino", website: "https://www.villadeipini.com/site/" },
];

process.env.POLICY_EXHAUSTIVE = "1";
process.env.OCR_ENABLED = "1";

for (const c of CASES) {
  console.log(`\n══ ${c.name} ══`);
  const crawl = await crawlSite(c.website);
  console.log(`  crawl ok: ${crawl.ok} | pages: ${crawl.pagesVisited.length} | relevant: ${crawl.foundRelevantPage}`);
  console.log(`  pdfs: ${crawl.policyPdfsRead}/${crawl.policyPdfsQueued} | exhaustive: ${crawl.policyExhaustive}`);
  if (!crawl.ok) { console.log(`  ERROR: ${crawl.error}`); continue; }
  const a = analyzeCrawlPolicy(crawl);
  const rec = reconcilePolicyVerdict(crawl, a, verdictFromSite({ reachable: true, policyFound: a.policyFound, foundRelevantPage: crawl.foundRelevantPage }), {
    companyName: c.company, website: c.website, city: c.city,
  });
  console.log(`  policyFound: ${a.policyFound} | company: ${a.policyCompany} | n° ${a.policyNumber}`);
  console.log(`  VERDETTO: ${rec.verdict}`);
  if (rec.note) console.log(`  note: ${rec.note}`);
  const trasparenza = crawl.pagesVisited.filter(u => /trasparen|documenti|polizz/i.test(u));
  console.log(`  pagine policy: ${trasparenza.slice(0, 5).join(" | ")}`);
}
