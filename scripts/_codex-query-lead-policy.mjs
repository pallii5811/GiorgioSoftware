import { prisma } from "../src/lib/sanita/db-ready.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";

const query = process.argv[2];
if (!query) throw new Error("name fragment required");
const leads = await prisma.lead.findMany({
  where: { companyName: { contains: query } },
  select: {
    id: true,
    companyName: true,
    city: true,
    region: true,
    policyFound: true,
    policyCompany: true,
    policyNumber: true,
    policyExpiry: true,
    evidence: true,
    lastScannedAt: true,
  },
});
console.log(JSON.stringify(leads.map((lead) => ({
  ...lead,
  verdict: readVerdictToken(lead.evidence),
  evidenceHead: lead.evidence?.slice(0, 500),
  evidence: undefined,
})), null, 2));
await prisma.$disconnect();
