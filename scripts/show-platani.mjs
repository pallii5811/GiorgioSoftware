import { prisma } from "../src/lib/sanita/db-ready.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";

const leads = await prisma.lead.findMany({
  where: { OR: [{ website: { contains: "malzoni" } }, { companyName: { contains: "Platani" } }] },
  select: { companyName: true, website: true, evidence: true },
});
for (const l of leads) {
  console.log(readVerdictToken(l.evidence), l.companyName, l.website?.slice(0, 40));
}
