import { prisma } from "../src/lib/prisma.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";

for (const region of ["Campania", "Veneto"]) {
  const tot = await prisma.lead.count({ where: { type: "HEALTHCARE", region } });
  const scanned = await prisma.lead.count({
    where: { type: "HEALTHCARE", region, lastScannedAt: { not: null } },
  });
  const pub = await prisma.lead.count({
    where: { type: "HEALTHCARE", region, evidence: { startsWith: "[V:PUBLISHED]" } },
  });
  const hot = await prisma.lead.count({
    where: { type: "HEALTHCARE", region, evidence: { startsWith: "[V:HOT]" } },
  });
  const rev = await prisma.lead.count({
    where: { type: "HEALTHCARE", region, evidence: { startsWith: "[V:REVIEW]" } },
  });
  console.log(`${region}: ${scanned}/${tot} | PUB=${pub} HOT=${hot} REVIEW=${rev}`);
}
await prisma.$disconnect();
