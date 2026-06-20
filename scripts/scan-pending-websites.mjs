/**
 * Analizza lead con sito già in DB ma lastScannedAt null (es. dopo reenrich).
 * Uso: DATABASE_URL=... SCAN_ENGINE_LOCAL=1 npx tsx scripts/scan-pending-websites.mjs Campania
 */
import { PrismaClient } from "@prisma/client";
import { completeLeadAnalysis, runBatch } from "../src/lib/sanita/scan-engine.ts";
import { closeMapsBrowserPool } from "../src/lib/sanita/playwright-maps.ts";
import { terminateOcrWorker } from "../src/lib/sanita/ocr.ts";

const p = new PrismaClient();
const region = process.argv[2] || "Campania";
const CONCURRENCY = Number(process.env.SCAN_CONCURRENCY || 2);

const pending = await p.lead.count({
  where: {
    type: "HEALTHCARE",
    region,
    website: { not: null },
    NOT: { website: "" },
    lastScannedAt: null,
  },
});
console.log(`Lead con sito da analizzare (${region}): ${pending}`);

let batchNum = 0;
while (true) {
  const batch = await p.lead.findMany({
    where: {
      type: "HEALTHCARE",
      region,
      website: { not: null },
      NOT: { website: "" },
      lastScannedAt: null,
    },
    orderBy: { createdAt: "asc" },
    take: CONCURRENCY,
  });
  if (batch.length === 0) break;

  batchNum++;
  const counters = {
    analyzed: 0,
    withPolicy: 0,
    hot: 0,
    review: 0,
    regionalChecked: 0,
    regionalWithPolicy: 0,
  };
  const t0 = Date.now();

  await runBatch(batch, CONCURRENCY, async (lead) => {
    try {
      await completeLeadAnalysis(lead, region, counters);
      const row = await p.lead.findUnique({
        where: { id: lead.id },
        select: { evidence: true, website: true },
      });
      console.log(`✓ ${lead.companyName} → ${row?.website ?? "?"} | ${row?.evidence?.slice(0, 40) ?? "?"}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`⚠ ${lead.companyName}: ${msg.slice(0, 80)}`);
      await p.lead.update({
        where: { id: lead.id },
        data: {
          lastScannedAt: new Date(),
          evidence: `[V:REVIEW] Errore analisi: ${msg.slice(0, 120)}`,
        },
      });
    }
  });

  const left = await p.lead.count({
    where: {
      type: "HEALTHCARE",
      region,
      website: { not: null },
      NOT: { website: "" },
      lastScannedAt: null,
    },
  });
  console.log(
    `batch ${batchNum} in ${Math.round((Date.now() - t0) / 1000)}s | hot+${counters.hot} pub+${counters.withPolicy} | restano ${left}`
  );
}

await terminateOcrWorker().catch(() => {});
await closeMapsBrowserPool().catch(() => {});
await p.$disconnect();
console.log("done");
