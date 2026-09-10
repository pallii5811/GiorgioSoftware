import { prisma } from "@/lib/prisma";
import { readProcessingState } from "@/lib/sanita/processing-state";

const [region, city] = process.argv.slice(2);
if (!region || !city) throw new Error("region and city required");

const rows = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", region, city },
  orderBy: { companyName: "asc" },
  select: {
    id: true,
    companyName: true,
    website: true,
    policyFound: true,
    policyCompany: true,
    policyNumber: true,
    policyExpiry: true,
    evidence: true,
    lastScannedAt: true,
  },
});

console.log(
  JSON.stringify(
    rows.map((row) => ({
      ...row,
      processingState: readProcessingState(row.evidence),
      evidence: String(row.evidence || "").slice(-4000),
    })),
    null,
    2
  )
);
await prisma.$disconnect();
