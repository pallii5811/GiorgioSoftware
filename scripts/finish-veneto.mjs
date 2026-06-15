/** Completa l'ultimo lead Veneto non analizzato (POLICY_EXHAUSTIVE + OCR). */
process.env.OCR_ENABLED = "1";
process.env.POLICY_EXHAUSTIVE = "1";

import { prisma } from "../src/lib/sanita/db-ready.ts";
import { completeLeadAnalysis } from "../src/lib/sanita/scan-engine.ts";
import { closeMapsBrowserPool } from "../src/lib/sanita/playwright-maps.ts";
import { terminateOcrWorker } from "../src/lib/sanita/ocr.ts";
import { installOcrSafetyHandlers } from "../src/lib/sanita/ocr.ts";

installOcrSafetyHandlers();

const pending = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", region: "Veneto", lastScannedAt: null },
});

console.log(`Veneto da completare: ${pending.length}`);
const counters = {
  analyzed: 0,
  withPolicy: 0,
  hot: 0,
  review: 0,
  regionalChecked: 0,
  regionalWithPolicy: 0,
};

for (const lead of pending) {
  console.log(`→ ${lead.companyName} (${lead.city ?? "?"}) sito=${lead.website ?? "nessuno"}`);
  await completeLeadAnalysis(lead, "Veneto", counters);
  const after = await prisma.lead.findUnique({
    where: { id: lead.id },
    select: { evidence: true, policyFound: true, phone: true, email: true },
  });
  console.log(`  ${after?.evidence?.slice(0, 80)}… tel=${after?.phone ?? "—"} email=${after?.email ?? "—"}`);
}

await terminateOcrWorker().catch(() => {});
await closeMapsBrowserPool().catch(() => {});
await prisma.$disconnect();
console.log(`\n✅ Veneto: hot=${counters.hot} pub=${counters.withPolicy} review=${counters.review}\n`);
