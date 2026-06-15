/**
 * Ri-analizza SOLO lead già scansionati — applica fix detector/UI senza reset totale.
 * Non tocca lastScannedAt=null → la coda in corso resta com'è.
 *
 * npx tsx scripts/refresh-analyzed-leads.mjs [Campania] [Veneto]
 */
process.env.POLICY_EXHAUSTIVE = "1";
process.env.OCR_ENABLED = "1";

import { prisma } from "../src/lib/sanita/db-ready.ts";
import { analyzeLead } from "../src/lib/sanita/scan-engine.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";
import { terminateOcrWorker } from "../src/lib/sanita/ocr.ts";
import { closeMapsBrowserPool } from "../src/lib/sanita/playwright-maps.ts";

const regions = process.argv.slice(2).filter((r) => ["Campania", "Veneto"].includes(r));
const targetRegions = regions.length ? regions : ["Campania", "Veneto"];

const counters = {
  analyzed: 0,
  withPolicy: 0,
  hot: 0,
  review: 0,
};

for (const region of targetRegions) {
  const leads = await prisma.lead.findMany({
    where: {
      type: "HEALTHCARE",
      region,
      lastScannedAt: { not: null },
      website: { not: null },
    },
    orderBy: { companyName: "asc" },
  });

  console.log(`\n══ ${region}: refresh ${leads.length} già analizzati ══\n`);

  for (const lead of leads) {
    const before = readVerdictToken(lead.evidence);
    // Non azzerare lastScannedAt — evita race con scan SSE parallelo
    await analyzeLead(lead, counters);
    const after = await prisma.lead.findUnique({
      where: { id: lead.id },
      select: {
        companyName: true,
        policyCompany: true,
        policyExpiry: true,
        evidence: true,
      },
    });
    const v = readVerdictToken(after?.evidence);
    const exp = after?.policyExpiry?.toISOString().slice(0, 10) ?? "—";
    if (before !== v || exp !== "—") {
      console.log(`  ${after?.companyName}: ${before} → ${v} | scadenza ${exp}`);
    }
  }
}

await terminateOcrWorker().catch(() => {});
await closeMapsBrowserPool().catch(() => {});
await prisma.$disconnect();
console.log("\nFatto.", counters);
