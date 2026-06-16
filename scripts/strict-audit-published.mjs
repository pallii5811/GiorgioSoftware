/**
 * Audit rigoroso SOLO per lead PUBLISHED già salvati:
 * ri-crawl e ricalcola verdetto con logica attuale.
 *
 * NON modifica il DB — produce un report JSONL.
 *
 * Uso:
 *   npx tsx scripts/strict-audit-published.mjs
 * Env:
 *   AUDIT_REGION=Campania,Veneto
 *   AUDIT_CONCURRENCY=2
 */
import { writeFileSync, appendFileSync } from "fs";
import { prisma } from "../src/lib/prisma.ts";
import { crawlSite } from "../src/lib/sanita/crawler.ts";
import { analyzeCrawlPolicy, reconcilePolicyVerdict } from "../src/lib/sanita/policy-verify.ts";
import { verdictFromSite, readVerdictToken } from "../src/lib/sanita/verdict.ts";

process.env.POLICY_EXHAUSTIVE = "1";
process.env.OCR_ENABLED = process.env.OCR_ENABLED ?? "1";
process.env.SCAN_FAST = "0";

const CONCURRENCY = Number(process.env.AUDIT_CONCURRENCY || 2);
const REPORT = "strict-audit-published.jsonl";
const REGIONS = (process.env.AUDIT_REGION || "Campania,Veneto").split(",").map((s) => s.trim());

writeFileSync(REPORT, "");

function write(obj) {
  appendFileSync(REPORT, JSON.stringify(obj) + "\n", "utf8");
}

async function auditOne(lead) {
  const stored = readVerdictToken(lead.evidence);
  if (stored !== "PUBLISHED") return null;
  if (!lead.website) {
    return {
      id: lead.id,
      name: lead.companyName,
      region: lead.region,
      stored,
      status: "NO_WEBSITE",
      ok: false,
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
      ok: false,
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
    city: lead.city,
    website: lead.website,
    stored,
    recomputed,
    match,
    ok: match,
    policyFound: analysis.policyFound,
    policyCompany: analysis.company,
    policyNumber: analysis.policyNumber,
    policyExpiry: analysis.expiry?.toISOString?.().slice(0, 10) ?? null,
    policyMassimale: analysis.massimale,
    pages: crawl.pagesVisited.length,
    pdfs: crawl.policyPdfsRead,
    pdfsQueued: crawl.policyPdfsQueued,
    foundRelevantPage: crawl.foundRelevantPage,
    policyExhaustive: crawl.policyExhaustive,
    needsOcrReview: crawl.needsOcrReview,
    reconcileNote: rec.note,
  };
}

async function runBatch(items, worker) {
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const slice = items.slice(i, i + CONCURRENCY);
    const res = await Promise.all(
      slice.map(async (x) => {
        try {
          return await worker(x);
        } catch (e) {
          return { id: x.id, name: x.companyName, region: x.region, status: "ERROR", error: String(e) };
        }
      })
    );
    for (const r of res) if (r) write(r);
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
    },
  });

  const pubs = leads.filter((l) => readVerdictToken(l.evidence) === "PUBLISHED");
  console.log(`PUBLISHED da auditare: ${pubs.length}`);

  await runBatch(pubs, auditOne);

  await terminateOcrWorker().catch(() => {});
  await prisma.$disconnect();
  console.log(`✓ Report scritto in ${REPORT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

