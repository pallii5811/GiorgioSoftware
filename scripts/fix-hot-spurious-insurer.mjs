import { prisma } from "../src/lib/prisma.ts";

const r = await prisma.lead.updateMany({
  where: {
    type: "HEALTHCARE",
    policyFound: false,
    evidence: { startsWith: "[V:HOT]" },
    NOT: { policyCompany: null },
  },
  data: {
    policyCompany: null,
    policyMassimale: null,
    policyNumber: null,
    policyExpiry: null,
    confidence: null,
  },
});
console.log("HOT senza polizza — compagnia spuria rimossa:", r.count);
await prisma.$disconnect();
