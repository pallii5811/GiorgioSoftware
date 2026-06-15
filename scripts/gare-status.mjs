import { prisma } from "../src/lib/prisma.ts";

for (const region of ["Campania", "Veneto"]) {
  const tot = await prisma.lead.count({ where: { type: "TENDER", region } });
  const withPhone = await prisma.lead.count({ where: { type: "TENDER", region, phone: { not: null } } });
  const withEmail = await prisma.lead.count({ where: { type: "TENDER", region, email: { not: null } } });
  const enriched = await prisma.lead.count({
    where: { type: "TENDER", region, lastScannedAt: { not: null } },
  });
  console.log(`${region} gare: ${tot} tot | ${enriched} arricchite | ${withPhone} tel | ${withEmail} email`);
}
await prisma.$disconnect();
