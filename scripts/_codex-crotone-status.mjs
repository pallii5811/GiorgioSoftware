import { prisma } from "@/lib/prisma";

const rows = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", region: "Calabria", city: "Crotone" },
  orderBy: [{ lastScannedAt: "desc" }, { companyName: "asc" }],
  select: {
    companyName: true,
    website: true,
    policyFound: true,
    lastScannedAt: true,
    evidence: true,
  },
});

console.log(
  JSON.stringify(
    rows.map((row) => ({
      ...row,
      evidence: row.evidence?.slice(0, 180) ?? null,
    })),
    null,
    2
  )
);
await prisma.$disconnect();
