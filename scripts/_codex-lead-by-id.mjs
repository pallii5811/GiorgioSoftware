import { prisma } from "@/lib/prisma";

const id = process.argv[2];
if (!id) throw new Error("lead id required");
const lead = await prisma.lead.findUnique({ where: { id } });
console.log(JSON.stringify(lead, null, 2));
await prisma.$disconnect();
