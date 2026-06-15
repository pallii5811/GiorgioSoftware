import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const delHealth = await prisma.lead.deleteMany({ where: { type: "HEALTHCARE" } });
const delTenderMock = await prisma.lead.deleteMany({
  where: { type: "TENDER", companyName: { contains: "Edilizia Costruzioni" } },
});
console.log("Deleted HEALTHCARE:", delHealth.count);
console.log("Deleted mock TENDER:", delTenderMock.count);
await prisma.$disconnect();
