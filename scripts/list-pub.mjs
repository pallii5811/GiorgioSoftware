import { prisma } from "../src/lib/prisma.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";

const leads = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", lastScannedAt: { not: null } },
  select: {
    companyName: true,
    policyCompany: true,
    policyNumber: true,
    policyExpiry: true,
    policyMassimale: true,
    confidence: true,
    evidence: true,
  },
});

for (const l of leads) {
  if (readVerdictToken(l.evidence) !== "PUBLISHED") continue;
  console.log(
    l.companyName,
    "| conf:", l.confidence,
    "| expiry:", l.policyExpiry?.toISOString().slice(0, 10) ?? "MANCA",
    "| comp:", l.policyCompany,
    "| n°:", l.policyNumber,
    "| mass:", l.policyMassimale
  );
}

await prisma.$disconnect();
