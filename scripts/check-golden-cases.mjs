import { prisma } from "../src/lib/sanita/db-ready.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";

const names = ["Fiorita", "Maugeri", "Hermitage", "Pineta"];
const leads = await prisma.lead.findMany({
  where: {
    type: "HEALTHCARE",
    OR: names.map((n) => ({ companyName: { contains: n } })),
  },
  select: {
    companyName: true,
    region: true,
    website: true,
    evidence: true,
    policyFound: true,
    policyCompany: true,
    policyNumber: true,
    websiteReachable: true,
    pagesVisited: true,
    lastScannedAt: true,
  },
});

console.log("\n═══ CASI GOLDEN (controllo manuale utente) ═══\n");
for (const l of leads) {
  const v = readVerdictToken(l.evidence);
  console.log(`${l.companyName} (${l.region})`);
  console.log(`  verdetto: ${v} | policyFound: ${l.policyFound}`);
  console.log(`  sito: ${l.website ?? "—"}`);
  console.log(`  compagnia: ${l.policyCompany ?? "—"} | n° ${l.policyNumber ?? "—"}`);
  console.log(`  reachable: ${l.websiteReachable} | pages: ${l.pagesVisited} | scanned: ${!!l.lastScannedAt}`);
  console.log();
}
await prisma.$disconnect();
