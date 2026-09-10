import { prisma } from "../src/lib/sanita/db-ready.ts";
import { readProcessingState } from "../src/lib/sanita/processing-state.ts";

const region = process.argv[2];
const city = process.argv[3];
if (!region || !city) throw new Error("usage: _codex-list-territory-leads.mjs <region> <city>");

const leads = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", region, city },
  select: {
    id: true,
    companyName: true,
    phone: true,
    website: true,
    osmId: true,
    evidence: true,
    lastScannedAt: true,
  },
  orderBy: { createdAt: "asc" },
});
console.log(JSON.stringify(leads.map(({ evidence, ...lead }) => ({
  ...lead,
  state: readProcessingState(evidence),
  evidence: String(evidence || "").slice(0, 300),
})), null, 2));
await prisma.$disconnect();
