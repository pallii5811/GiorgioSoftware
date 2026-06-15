import { PrismaClient } from "@prisma/client";
import { completeLeadAnalysis } from "../src/lib/sanita/scan-engine.ts";
import { closeMapsBrowserPool } from "../src/lib/sanita/playwright-maps.ts";

const prisma = new PrismaClient();
const lead = await prisma.lead.findFirst({
  where: { companyName: { contains: "Pineta Grande" } },
});
if (!lead) {
  console.error("Pineta non trovata");
  process.exit(1);
}

await prisma.lead.update({
  where: { id: lead.id },
  data: { website: null, lastScannedAt: null, websiteReachable: null },
});

console.log("Prima:", lead.companyName, lead.city);
const counters = { analyzed: 0, withPolicy: 0, hot: 0, review: 0, regionalChecked: 0, regionalWithPolicy: 0 };
await completeLeadAnalysis(lead, "Campania", counters);

const after = await prisma.lead.findUnique({ where: { id: lead.id } });
console.log("Dopo:", after?.website, after?.evidence?.slice(0, 80));

await closeMapsBrowserPool();
await prisma.$disconnect();
process.exit(after?.website?.includes("pinetagrande") ? 0 : 1);
