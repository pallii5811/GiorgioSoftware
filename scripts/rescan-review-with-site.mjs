/**
 * Riscan REVIEW con sito — crawl completo (POLICY_EXHAUSTIVE, no FAST).
 * Uso: npx tsx scripts/rescan-review-with-site.mjs [Campania] [Veneto]
 */
process.env.OCR_ENABLED = "1";
process.env.POLICY_EXHAUSTIVE = "1";
process.env.SCAN_FAST = "0";
process.env.SCAN_ENGINE_LOCAL = "1";

import { prisma } from "../src/lib/sanita/db-ready.ts";
import { completeLeadAnalysis, runBatch } from "../src/lib/sanita/scan-engine.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";
import { terminateOcrWorker } from "../src/lib/sanita/ocr.ts";
import { closeMapsBrowserPool } from "../src/lib/sanita/playwright-maps.ts";

const regions = process.argv.slice(2).filter((r) => ["Campania", "Veneto"].includes(r));
const targets = regions.length ? regions : ["Campania", "Veneto"];

for (const region of targets) {
  const leads = await prisma.lead.findMany({
    where: {
      type: "HEALTHCARE",
      region,
      evidence: { startsWith: "[V:REV]" },
      website: { not: null },
      NOT: { website: "" },
    },
    orderBy: { lastScannedAt: "asc" },
  });

  console.log(`\n═══ ${region}: ${leads.length} REVIEW con sito — crawl completo ═══`);
  let i = 0;
  await runBatch(leads, 1, async (lead) => {
    await prisma.lead.update({ where: { id: lead.id }, data: { lastScannedAt: null } });
    i++;
    const c = { analyzed: 0, withPolicy: 0, hot: 0, review: 0, regionalChecked: 0, regionalWithPolicy: 0 };
    await completeLeadAnalysis(lead, region, c);
    const fresh = await prisma.lead.findUnique({
      where: { id: lead.id },
      select: { evidence: true, pagesVisited: true },
    });
    console.log(
      `[${i}/${leads.length}]`,
      lead.companyName?.slice(0, 42),
      "→",
      readVerdictToken(fresh?.evidence),
      `pages=${fresh?.pagesVisited ?? 0}`
    );
  });
}

await Promise.race([
  Promise.all([
    terminateOcrWorker().catch(() => {}),
    closeMapsBrowserPool().catch(() => {}),
    prisma.$disconnect(),
  ]),
  new Promise((r) => setTimeout(r, 15_000)),
]);
process.exit(0);
