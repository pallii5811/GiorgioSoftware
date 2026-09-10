import { prisma } from "@/lib/prisma";

const query = process.argv.slice(2).join(" ").trim();
if (!query) throw new Error("company query required");

const rows = await prisma.lead.findMany({
  where: {
    type: "HEALTHCARE",
    region: "Calabria",
    city: "Crotone",
    companyName: { contains: query },
  },
  select: {
    id: true,
    companyName: true,
    website: true,
    policyFound: true,
    policyCompany: true,
    policyNumber: true,
    policyExpiry: true,
    evidence: true,
    lastScannedAt: true,
  },
});

console.log(JSON.stringify(rows, null, 2));
await prisma.$disconnect();
