/**
 * Rianalizza lead HOT (possibile falso positivo da OCR disattivato) con OCR attivo.
 * Uso: npx tsx scripts/rescan-hot-ocr.mjs [Campania] [Veneto]
 */
import { PrismaClient } from "@prisma/client";

process.env.OCR_ENABLED = "1";

const regions = process.argv.slice(2).filter((r) => ["Campania", "Veneto"].includes(r));
const targetRegions = regions.length ? regions : ["Campania", "Veneto"];

const prisma = new PrismaClient();
const { completeLeadAnalysis, runBatch } = await import("../src/lib/sanita/scan-engine.ts");
const { closeMapsBrowserPool } = await import("../src/lib/sanita/playwright-maps.ts");
const { terminateOcrWorker } = await import("../src/lib/sanita/ocr.ts");

for (const region of targetRegions) {
  const ids = await prisma.lead.findMany({
    where: {
      type: "HEALTHCARE",
      region,
      evidence: { startsWith: "[V:HOT]" },
      website: { not: null },
    },
    select: { id: true, companyName: true },
  });

  console.log(`\n${region}: rianalisi ${ids.length} HOT con OCR…`);

  await prisma.lead.updateMany({
    where: { id: { in: ids.map((l) => l.id) } },
    data: { lastScannedAt: null, websiteReachable: null },
  });

  const leads = await prisma.lead.findMany({ where: { id: { in: ids.map((l) => l.id) } } });
  let pub = 0;
  let hot = 0;

  await runBatch(leads, 2, async (lead) => {
    const c = { analyzed: 0, withPolicy: 0, hot: 0, review: 0, regionalChecked: 0, regionalWithPolicy: 0 };
    await completeLeadAnalysis(lead, region, c);
    const fresh = await prisma.lead.findUnique({ where: { id: lead.id }, select: { evidence: true } });
    if (fresh?.evidence?.startsWith("[V:PUB]")) pub++;
    else if (fresh?.evidence?.startsWith("[V:HOT]")) hot++;
    process.stdout.write(`\r  ${pub + hot}/${leads.length} | PUB+${pub} HOT=${hot}`);
  });
  console.log(`\n✓ ${region} finito\n`);
}

await terminateOcrWorker().catch(() => {});
await closeMapsBrowserPool().catch(() => {});
await prisma.$disconnect();
