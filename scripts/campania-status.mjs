import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const region = "Campania";
const total = await prisma.lead.count({ where: { type: "HEALTHCARE", region } });
const scanned = await prisma.lead.count({
  where: { type: "HEALTHCARE", region, lastScannedAt: { not: null } },
});
const noSite = await prisma.lead.count({
  where: { type: "HEALTHCARE", region, OR: [{ website: null }, { website: "" }] },
});
const pineta = await prisma.lead.findFirst({
  where: { companyName: { contains: "Pineta Grande" } },
  select: { companyName: true, website: true, lastScannedAt: true },
});
const santa = await prisma.lead.findFirst({
  where: { companyName: { contains: "Santa Patrizia" } },
  select: { companyName: true, website: true, lastScannedAt: true },
});
console.log({ total, scanned, noSite, pineta, santa });
await prisma.$disconnect();
