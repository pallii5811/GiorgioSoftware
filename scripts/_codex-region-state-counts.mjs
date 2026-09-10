import { prisma } from "@/lib/prisma";
import { readProcessingState } from "@/lib/sanita/processing-state";

const region = process.argv[2];
if (!region) throw new Error("region required");
const leads = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", region },
  select: { id: true, companyName: true, city: true, lastScannedAt: true, evidence: true },
});
const counts = {};
for (const lead of leads) {
  const state = readProcessingState(lead.evidence) || (lead.lastScannedAt ? "SCANNED_NO_STATE" : "UNSCANNED");
  counts[state] = (counts[state] || 0) + 1;
}
console.log(JSON.stringify({
  region,
  total: leads.length,
  scanned: leads.filter((lead) => lead.lastScannedAt).length,
  counts,
  recent: leads
    .filter((lead) => lead.lastScannedAt)
    .sort((a, b) => String(b.lastScannedAt).localeCompare(String(a.lastScannedAt)))
    .slice(0, 20)
    .map(({ evidence, ...lead }) => ({
      ...lead,
      state: readProcessingState(evidence),
      evidence: String(evidence || "").slice(0, 1200),
    })),
}, null, 2));
await prisma.$disconnect();
