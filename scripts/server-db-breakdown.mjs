import { prisma } from "../src/lib/prisma.ts";

const perRegion = await prisma.lead.groupBy({
  by: ["region"],
  where: { type: "HEALTHCARE" },
  _count: true,
});
const minSalute = await prisma.lead.count({
  where: { type: "HEALTHCARE", osmId: { startsWith: "min-salute/" } },
});
const mapsOnly = await prisma.lead.count({
  where: { type: "HEALTHCARE", NOT: { osmId: { startsWith: "min-salute/" } } },
});
const overlap = await prisma.$queryRaw`
  SELECT COUNT(*) as c FROM Lead m
  INNER JOIN Lead g ON m.region=g.region AND lower(m.companyName)=lower(g.companyName)
  WHERE m.type='HEALTHCARE' AND g.type='HEALTHCARE'
  AND m.osmId LIKE 'min-salute/%' AND g.osmId NOT LIKE 'min-salute/%'`;

console.log(JSON.stringify({ perRegion, minSalute, mapsOnly, totale: minSalute + mapsOnly, overlap }, null, 2));
await prisma.$disconnect();
