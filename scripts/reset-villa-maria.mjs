import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const r = await p.lead.updateMany({
  where: { region: "Campania", companyName: { contains: "Villa Maria" } },
  data: { lastScannedAt: null, website: null },
});
console.log("RESET", r.count);
await p.$disconnect();
