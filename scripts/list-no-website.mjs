import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const region = process.argv[2] || "Campania";
const leads = await p.lead.findMany({
  where: { type: "HEALTHCARE", region, OR: [{ website: null }, { website: "" }] },
  select: { companyName: true, city: true },
  orderBy: { companyName: "asc" },
});
console.log(JSON.stringify({ count: leads.length, leads: leads.slice(0, 30) }, null, 2));
await p.$disconnect();
