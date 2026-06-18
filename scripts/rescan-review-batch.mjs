/**
 * Rianalizza lead REVIEW con sito (falsi "da verificare" dopo fix detector/crawler).
 * Uso: npx tsx scripts/rescan-review-batch.mjs [Campania] [Veneto]
 *      SKIP_REGION=Campania npx tsx scripts/rescan-review-batch.mjs   (salta Campania se rescan UI attivo)
 */
process.env.OCR_ENABLED = "1";
process.env.POLICY_EXHAUSTIVE = "1";

import { prisma } from "../src/lib/sanita/db-ready.ts";
import { completeLeadAnalysis, runBatch } from "../src/lib/sanita/scan-engine.ts";
import { dedupeRegionByWebsite } from "../src/lib/sanita/lead-dedup.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";
import { terminateOcrWorker } from "../src/lib/sanita/ocr.ts";
import { closeMapsBrowserPool } from "../src/lib/sanita/playwright-maps.ts";

const skipRegion = process.env.SKIP_REGION || "";
const regions = process.argv
  .slice(2)
  .filter((r) => ["Campania", "Veneto"].includes(r));
const targetRegions = regions.length ? regions : ["Campania", "Veneto"];

for (const region of targetRegions) {
  if (region === skipRegion) {
    console.log(`\n${region}: saltata (SKIP_REGION)`);
    continue;
  }

  const removed = await dedupeRegionByWebsite(region);
  if (removed > 0) console.log(`${region}: dedup sito −${removed}`);

  const leads = await prisma.lead.findMany({
    where: {
      type: "HEALTHCARE",
      region,
      evidence: { startsWith: "[V:REV]" },
      website: { not: null },
    },
    orderBy: { lastScannedAt: "asc" },
  });

  console.log(`\n${region}: rianalisi ${leads.length} REVIEW con sito…`);

  await prisma.lead.updateMany({
    where: { id: { in: leads.map((l) => l.id) } },
    data: { lastScannedAt: null },
  });

  let pub = 0;
  let hot = 0;
  let rev = 0;
  let done = 0;

  await runBatch(leads, 1, async (lead) => {
    const c = { analyzed: 0, withPolicy: 0, hot: 0, review: 0, regionalChecked: 0, regionalWithPolicy: 0 };
    await completeLeadAnalysis(lead, region, c);
    const fresh = await prisma.lead.findUnique({ where: { id: lead.id }, select: { evidence: true } });
    const v = readVerdictToken(fresh?.evidence);
    if (v === "PUBLISHED") pub++;
    else if (v === "HOT") hot++;
    else rev++;
    done++;
    console.log(`  [${done}/${leads.length}] ${lead.companyName?.slice(0, 42)} → ${v}`);
  });

  console.log(`✓ ${region}: PUB=${pub} HOT=${hot} REVIEW=${rev}`);
}

await terminateOcrWorker().catch(() => {});
await closeMapsBrowserPool().catch(() => {});
