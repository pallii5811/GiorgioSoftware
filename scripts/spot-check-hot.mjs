/**
 * Ricontrolla un campione di HOT: ri-crawl + verdetto.
 * npm run spot:hot
 */
import { prisma } from "../src/lib/sanita/db-ready.ts";
import { crawlSite } from "../src/lib/sanita/crawler.ts";
import { analyzeCrawlPolicy, reconcilePolicyVerdict } from "../src/lib/sanita/policy-verify.ts";
import { verdictFromSite } from "../src/lib/sanita/verdict.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";

process.env.OCR_ENABLED = "0";
process.env.SCAN_FAST = "1";

const SAMPLE = Number(process.env.SPOT_SAMPLE || 12);

const hotWithSite = await prisma.lead.findMany({
  where: {
    type: "HEALTHCARE",
    evidence: { startsWith: "[V:HOT]" },
    website: { not: null },
    websiteReachable: true,
    lastScannedAt: { not: null },
  },
  orderBy: { leadScore: "desc" },
  take: SAMPLE,
});

// Casi noti che DEVONO essere PUBLISHED (regressioni)
const mustPub = await prisma.lead.findMany({
  where: {
    type: "HEALTHCARE",
    OR: [
      { companyName: { contains: "Villa Fiorita", mode: "insensitive" } },
      { companyName: { contains: "Maugeri", mode: "insensitive" } },
      { website: { contains: "villafioritacapua", mode: "insensitive" } },
      { website: { contains: "icsmaugeri", mode: "insensitive" } },
    ],
  },
  select: {
    companyName: true,
    website: true,
    evidence: true,
    policyFound: true,
    policyCompany: true,
    pagesVisited: true,
  },
});

console.log("\n═══ REGRESSIONI (devono essere PUBLISHED) ═══\n");
for (const l of mustPub) {
  const v = readVerdictToken(l.evidence);
  const ok = v === "PUBLISHED" && l.policyFound;
  console.log(`${ok ? "✓" : "✗"} ${l.companyName}`);
  console.log(`   verdetto=${v} policyFound=${l.policyFound} company=${l.policyCompany ?? "—"}`);
  console.log(`   ${l.website} | pages=${l.pagesVisited}`);
}

console.log(`\n═══ SPOT CHECK ${hotWithSite.length} HOT con sito (ri-crawl) ═══\n`);

let confirmed = 0;
let falseHot = 0;
let inconclusive = 0;

for (const lead of hotWithSite) {
  const oldV = readVerdictToken(lead.evidence);
  if (!lead.website) continue;

  const crawl = await crawlSite(lead.website);
  if (!crawl.ok) {
    console.log(`? ${lead.companyName?.slice(0, 45)} — crawl fallito: ${crawl.error}`);
    inconclusive++;
    continue;
  }

  const analysis = analyzeCrawlPolicy(crawl);
  let verdict = verdictFromSite({
    reachable: true,
    policyFound: analysis.policyFound,
    foundRelevantPage: crawl.foundRelevantPage,
  });
  const rec = reconcilePolicyVerdict(crawl, analysis, verdict);
  verdict = rec.verdict;

  const match = verdict === "HOT";
  if (match) confirmed++;
  else if (verdict === "PUBLISHED") falseHot++;
  else inconclusive++;

  const icon = match ? "✓ HOT" : verdict === "PUBLISHED" ? "✗ FALSO HOT→PUB" : "? REVIEW";
  console.log(
    `${icon} ${lead.companyName?.slice(0, 42)} | pages=${crawl.pagesVisited.length} relevant=${crawl.foundRelevantPage} policy=${analysis.policyFound}`
  );
  if (!match && analysis.policyFound) {
    console.log(`     → ${analysis.company} | ${analysis.policyNumber}`);
  }
}

console.log(
  `\nRisultato campione: ${confirmed} HOT confermati, ${falseHot} falsi HOT, ${inconclusive} non conclusivi\n`
);
await prisma.$disconnect();
