import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

for (const region of ["Campania", "Veneto"]) {
  const total = await prisma.lead.count({ where: { type: "HEALTHCARE", region } });
  const scanned = await prisma.lead.count({
    where: { type: "HEALTHCARE", region, lastScannedAt: { not: null } },
  });
  const noSite = await prisma.lead.count({
    where: { type: "HEALTHCARE", region, OR: [{ website: null }, { website: "" }] },
  });
  const withSite = total - noSite;
  const minSalute = await prisma.lead.count({
    where: { type: "HEALTHCARE", region, osmId: { startsWith: "min-salute/" } },
  });
  const minSaluteNoSite = await prisma.lead.count({
    where: {
      type: "HEALTHCARE",
      region,
      osmId: { startsWith: "min-salute/" },
      OR: [{ website: null }, { website: "" }],
    },
  });
  const hot = await prisma.lead.count({
    where: { type: "HEALTHCARE", region, evidence: { startsWith: "[V:HOT]" } },
  });
  const pub = await prisma.lead.count({
    where: { type: "HEALTHCARE", region, evidence: { startsWith: "[V:PUB]" } },
  });
  const audit = await prisma.lead.count({
    where: { type: "HEALTHCARE", region, evidence: { contains: "[FONTI:" } },
  });
  console.log(
    `${region}: ${scanned}/${total} scansionati | sito=${withSite} noSito=${noSite} (min-salute ${minSaluteNoSite}/${minSalute} senza URL) | HOT=${hot} PUB=${pub}`
  );
}

await prisma.$disconnect();
