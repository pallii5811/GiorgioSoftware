import { prisma } from "../src/lib/prisma.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";

const l = await prisma.lead.findFirst({
  where: { companyName: { contains: "Giovanni e Paolo" } },
});
if (!l) {
  console.log("not found");
} else {
  console.log({
    name: l.companyName,
    verdict: readVerdictToken(l.evidence),
    policyFound: l.policyFound,
    policyCompany: l.policyCompany,
    policyMassimale: l.policyMassimale,
    website: l.website,
    evidence: l.evidence?.slice(0, 400),
  });
}
await prisma.$disconnect();
