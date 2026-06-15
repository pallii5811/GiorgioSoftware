/**
 * Audit rigoroso: ri-crawl ogni struttura GIÀ analizzata e confronta verdetto.
 * NON modifica il DB — solo report per certificazione manuale.
 *
 * npx tsx scripts/strict-audit-all.mjs
 */
import { writeFileSync, appendFileSync } from "fs";
import { prisma } from "../src/lib/prisma.ts";
import { crawlSite } from "../src/lib/sanita/crawler.ts";
import { analyzeCrawlPolicy, reconcilePolicyVerdict } from "../src/lib/sanita/policy-verify.ts";
import { verdictFromSite, readVerdictToken } from "../src/lib/sanita/verdict.ts";

process.env.POLICY_EXHAUSTIVE = "1";
process.env.OCR_ENABLED = process.env.OCR_ENABLED ?? "1";
process.env.SCAN_FAST = "0";

const CONCURRENCY = Number(process.env.AUDIT_CONCURRENCY || 3);
const REPORT = "strict-audit-report.jsonl";
const REGIONS = (process.env.AUDIT_REGION || "Campania,Veneto").split(",").map((s) => s.trim());

writeFileSync(REPORT, "");

function classifyMismatch(stored, recomputed, crawl, rec) {
  if (stored === "HOT" && recomputed === "PUBLISHED") return "FALSE_HOT";
  if (stored === "PUBLISHED" && recomputed === "HOT") return "FALSE_PUB";
  if (stored === "HOT" && recomputed === "REVIEW") return "HOT_DOWNGRADE";
  if (stored === "PUBLISHED" && recomputed === "REVIEW") return "PUB_DOWNGRADE";
  if (stored === "REVIEW" && recomputed === "HOT") return "REVIEW_TO_HOT";
  if (stored === "REVIEW" && recomputed === "PUBLISHED") return "REVIEW_TO_PUB";
  return "OTHER";
}

async function auditOne(lead) {
  const stored = readVerdictToken(lead.evidence);

  if (!lead.website) {
    return {
      id: lead.id,
      name: lead.companyName,
      region: lead.region,
      stored,
      status: "NO_WEBSITE",
      ok: stored === "HOT" || stored === "REVIEW",
    };
  }

  const crawl = await crawlSite(lead.website);

  if (!crawl.ok) {
    return {
      id: lead.id,
      name: lead.companyName,
      region: lead.region,
      website: lead.website,
      stored,
      status: "SITE_DOWN",
      crawlError: crawl.error,
      ok: stored !== "HOT" && stored !== "PUBLISHED",
      note: stored === "HOT" ? "HOT con sito irraggiungibile — NON CERTIFICABILE" : null,
    };
  }

  const analysis = analyzeCrawlPolicy(crawl);
  const prelim = verdictFromSite({
    reachable: true,
    policyFound: analysis.policyFound,
    foundRelevantPage: crawl.foundRelevantPage,
  });
  const rec = reconcilePolicyVerdict(crawl, analysis, prelim, {
    companyName: lead.companyName,
    website: lead.website,
    city: lead.city,
  });
  const recomputed = rec.verdict;
  const match = stored === recomputed;

  return {
    id: lead.id,
    name: lead.companyName,
    region: lead.region,
    website: lead.website,
    stored,
    recomputed,
    match,
    ok: match,
    status: match ? "PASS" : classifyMismatch(stored, recomputed, crawl, rec),
    policyFound: analysis.policyFound,
    policyCompany: analysis.company,
    policyNumber: analysis.policyNumber,
    pages: crawl.pagesVisited.length,
    pdfs: crawl.policyPdfsRead,
    pdfsQueued: crawl.policyPdfsQueued,
    foundRelevantPage: crawl.foundRelevantPage,
    policyExhaustive: crawl.policyExhaustive,
    reconcileNote: rec.note,
    gates: !match ? rec.note : null,
  };
}

async function runBatch(items, worker) {
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    await Promise.all(items.slice(i, i + CONCURRENCY).map(worker));
  }
}

async function main() {
  const { installOcrSafetyHandlers, terminateOcrWorker } = await import("../src/lib/sanita/ocr.ts");
  installOcrSafetyHandlers();

  const leads = await prisma.lead.findMany({
    where: {
      type: "HEALTHCARE",
      region: { in: REGIONS },
      lastScannedAt: { not: null },
    },
    orderBy: [{ region: "asc" }, { companyName: "asc" }],
    select: {
      id: true,
      companyName: true,
      region: true,
      city: true,
      website: true,
      evidence: true,
      websiteReachable: true,
      pagesVisited: true,
      policyFound: true,
    },
  });

  console.log(`\n═══ STRICT AUDIT — ${leads.length} strutture analizzate ═══\n`);

  const summary = {
    total: leads.length,
    pass: 0,
    fail: 0,
    siteDown: 0,
    noWebsite: 0,
    falseHot: 0,
    falsePub: 0,
    otherMismatch: 0,
    byStored: { HOT: 0, PUBLISHED: 0, REVIEW: 0, null: 0 },
  };

  let done = 0;

  await runBatch(leads, async (lead) => {
    try {
      const r = await auditOne(lead);
      done++;
      const stored = r.stored;
      if (stored === "HOT") summary.byStored.HOT++;
      else if (stored === "PUBLISHED") summary.byStored.PUBLISHED++;
      else if (stored === "REVIEW") summary.byStored.REVIEW++;
      else summary.byStored.null++;

      if (r.status === "SITE_DOWN") summary.siteDown++;
      else if (r.status === "NO_WEBSITE") summary.noWebsite++;
      else if (r.ok) summary.pass++;
      else {
        summary.fail++;
        if (r.status === "FALSE_HOT") summary.falseHot++;
        else if (r.status === "FALSE_PUB") summary.falsePub++;
        else summary.otherMismatch++;
        console.log(`  ✗ ${r.status} | ${r.name} | stored=${r.stored} → audit=${r.recomputed}`);
        if (r.gates) console.log(`    ${r.gates}`);
      }

      appendFileSync(REPORT, JSON.stringify(r) + "\n");
      if (done % 10 === 0) console.log(`  … ${done}/${leads.length} (pass ${summary.pass}, fail ${summary.fail})`);
    } catch (e) {
      summary.fail++;
      appendFileSync(
        REPORT,
        JSON.stringify({ id: lead.id, name: lead.companyName, status: "ERROR", error: String(e) }) + "\n"
      );
    }
  });

  await terminateOcrWorker().catch(() => {});
  await prisma.$disconnect();

  console.log("\n═══ RISULTATO AUDIT ═══");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Report: ${REPORT}\n`);
  process.exit(summary.falseHot > 0 || summary.falsePub > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
