import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const total = await prisma.lead.count({ where: { type: "HEALTHCARE", region: "Veneto" } });
const temp = await prisma.lead.count({ where: { type: "HEALTHCARE", region: "Veneto", status: "NEW" } });
const saved = await prisma.lead.count({ where: { type: "HEALTHCARE", region: "Veneto", status: { not: "NEW" } } });
console.log("TOTAL:", total, "TEMP:", temp, "SAVED:", saved);
await prisma.$disconnect();
