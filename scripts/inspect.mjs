import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const analyzed = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", lastScannedAt: { not: null } },
  orderBy: { policyFound: "desc" },
});

console.log(`\n=== ${analyzed.length} STRUTTURE ANALIZZATE (dati reali) ===\n`);
for (const l of analyzed) {
  console.log(`• ${l.companyName} (${l.city || "?"}) [${l.category}]`);
  console.log(`   sito: ${l.website}`);
  console.log(`   raggiungibile: ${l.websiteReachable} | pagine: ${l.pagesVisited} | polizza trovata: ${l.policyFound} | confidence: ${l.confidence}`);
  if (l.policyCompany) console.log(`   compagnia: ${l.policyCompany} | massimale: ${l.policyMassimale} | scadenza: ${l.policyExpiry}`);
  if (l.evidence) console.log(`   evidenza: "${String(l.evidence).slice(0, 160)}..."`);
  console.log("");
}

const total = await prisma.lead.count({ where: { type: "HEALTHCARE" } });
const withSite = await prisma.lead.count({ where: { type: "HEALTHCARE", website: { not: null } } });
console.log(`Totale strutture: ${total} | con sito web: ${withSite}`);
await prisma.$disconnect();
