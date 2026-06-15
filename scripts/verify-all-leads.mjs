/**
 * Auto-verifica ogni struttura con sito: ri-scrape + confronto verdetto + correzione DB.
 * npm run verify:all
 */
import { writeFileSync, appendFileSync } from "fs";
import { prisma } from "../src/lib/prisma.ts";
import { crawlSite } from "../src/lib/sanita/crawler.ts";
import { analyzeCrawlPolicy, reconcilePolicyVerdict } from "../src/lib/sanita/policy-verify.ts";
import { verdictFromSite } from "../src/lib/sanita/verdict.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";
import { packEvidence } from "../src/lib/sanita/audit.ts";
import { scoreLead } from "../src/lib/sanita/score.ts";

const REGIONS = (process.env.VERIFY_REGION || "Campania,Veneto").split(",").map((s) => s.trim());
const CONCURRENCY = Number(process.env.VERIFY_CONCURRENCY || 6);
const REPORT = "verify-report.jsonl";
const LIMIT = Number(process.env.VERIFY_LIMIT || 0);

process.env.SCAN_FAST = "0";
// OCR off in verify batch: evita crash Tesseract in parallelo; PDF digitali coperti.
process.env.OCR_ENABLED = "0";

writeFileSync(REPORT, "");

async function verifyOne(lead) {
  if (!lead.website) return { id: lead.id, skip: "no website" };

  const crawl = await crawlSite(lead.website);
  if (!crawl.ok) {
    return { id: lead.id, name: lead.companyName, skip: crawl.error };
  }

  const analysis = analyzeCrawlPolicy(crawl);
  let verdict = verdictFromSite({
    reachable: true,
    policyFound: analysis.policyFound,
    foundRelevantPage: crawl.foundRelevantPage,
  });
  const rec = reconcilePolicyVerdict(crawl, analysis, verdict, {
    companyName: lead.companyName,
    website: lead.website,
    city: lead.city,
  });
  verdict = rec.verdict;

  const oldVerdict = readVerdictToken(lead.evidence);
  const changed = oldVerdict !== verdict;

  if (changed) {
    const body =
      (rec.note ? `${rec.note} ` : "") +
      (analysis.evidence ||
        (verdict === "HOT"
          ? "Polizza non pubblicata su Trasparenza/PDF verificati."
          : verdict === "PUBLISHED"
            ? "Polizza pubblicata su sito (auto-verifica)."
            : "Verifica non conclusiva."));
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        policyFound: analysis.policyFound,
        policyCompany: analysis.company,
        policyMassimale: analysis.massimale,
        policyNumber: analysis.policyNumber,
        policyExpiry: analysis.expiry,
        confidence: analysis.confidence,
        websiteReachable: true,
        pagesVisited: crawl.pagesVisited.length,
        leadScore: scoreLead({
          verdict,
          phone: lead.phone,
          email: lead.email,
          pec: lead.pec,
          expiry: analysis.expiry,
          obsoletePolicy: analysis.policyObsolete,
        }),
        evidence: packEvidence(verdict, body, {
          osm: true,
          sitePages: crawl.pagesVisited,
          siteRelevant: crawl.foundRelevantPage,
        }),
        lastScannedAt: new Date(),
      },
    });
  }

  return {
    id: lead.id,
    name: lead.companyName,
    region: lead.region,
    website: lead.website,
    oldVerdict,
    newVerdict: verdict,
    changed,
    policyFound: analysis.policyFound,
    company: analysis.company,
    pdfs: crawl.pagesVisited.filter((u) => /\.pdf/i.test(u)).length,
    policyTextLen: crawl.policyText?.length ?? 0,
  };
}

async function runBatch(items, worker) {
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const chunk = items.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(worker));
  }
}

async function main() {
  const { installOcrSafetyHandlers } = await import("../src/lib/sanita/ocr.ts");
  installOcrSafetyHandlers();

  const leads = await prisma.lead.findMany({
    where: {
      type: "HEALTHCARE",
      region: { in: REGIONS },
      website: { not: null },
    },
    orderBy: [{ region: "asc" }, { companyName: "asc" }],
    ...(LIMIT > 0 ? { take: LIMIT } : {}),
  });

  console.log(`\n🔍 VERIFY ALL — ${leads.length} strutture con sito (${REGIONS.join(", ")})\n`);

  let done = 0;
  let fixed = 0;
  let errors = 0;

  await runBatch(leads, async (lead) => {
    try {
      const r = await verifyOne(lead);
      done++;
      if (r.changed) {
        fixed++;
        console.log(`  ✎ ${r.name}: ${r.oldVerdict ?? "?"} → ${r.newVerdict}`);
      }
      appendFileSync(REPORT, JSON.stringify(r) + "\n");
      if (done % 25 === 0) console.log(`  … ${done}/${leads.length} (${fixed} corretti)`);
    } catch (e) {
      errors++;
      appendFileSync(
        REPORT,
        JSON.stringify({ id: lead.id, name: lead.companyName, error: String(e) }) + "\n"
      );
    }
  });

  console.log(`\n✅ Fine: ${done} verificate, ${fixed} corretti, ${errors} errori`);
  console.log(`   Report: ${REPORT}\n`);
  await prisma.$disconnect();
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
