import { prisma } from "../src/lib/sanita/db-ready.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";

const lead = await prisma.lead.findFirst({
  where: { companyName: { contains: "Pronto Soccorso" } },
});
if (!lead) {
  console.log("NOT_FOUND");
  process.exit(1);
}
console.log(
  lead.companyName,
  readVerdictToken(lead.evidence),
  lead.policyCompany,
  lead.policyNumber,
  lead.lastScannedAt
);
console.log((lead.evidence || "").slice(0, 350));
