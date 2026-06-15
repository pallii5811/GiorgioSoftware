import { prisma } from "../src/lib/prisma.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";

const leads = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", lastScannedAt: { not: null } },
  select: {
    companyName: true,
    region: true,
    city: true,
    website: true,
    websiteReachable: true,
    pagesVisited: true,
    policyFound: true,
    policyCompany: true,
    policyNumber: true,
    evidence: true,
  },
  orderBy: [{ region: "asc" }, { companyName: "asc" }],
});

for (const l of leads) {
  const v = readVerdictToken(l.evidence);
  console.log("---");
  console.log(`${l.companyName} (${l.region}${l.city ? ", " + l.city : ""})`);
  console.log(`  verdetto: ${v} | policyFound: ${l.policyFound}`);
  console.log(`  sito: ${l.website ?? "—"} | reachable: ${l.websiteReachable} | pages: ${l.pagesVisited}`);
  if (l.policyCompany) console.log(`  compagnia: ${l.policyCompany} n°${l.policyNumber ?? "?"}`);
  const body = (l.evidence || "").replace(/^\[V:(PUB|HOT|REV)\]\s*/i, "").slice(0, 180);
  console.log(`  evidence: ${body}…`);
}
console.log("\nTOTALE analizzate:", leads.length);
await prisma.$disconnect();
