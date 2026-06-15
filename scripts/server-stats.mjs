import { prisma } from "../src/lib/prisma.ts";

const total = await prisma.lead.count({ where: { type: "HEALTHCARE" } });
const hot = await prisma.lead.count({
  where: { type: "HEALTHCARE", evidence: { startsWith: "[V:HOT]" } },
});
const pub = await prisma.lead.count({
  where: { type: "HEALTHCARE", evidence: { startsWith: "[V:PUB]" } },
});
const pending = await prisma.lead.count({
  where: { type: "HEALTHCARE", lastScannedAt: null },
});
console.log(JSON.stringify({ total, hot, pub, pending }));
await prisma.$disconnect();
