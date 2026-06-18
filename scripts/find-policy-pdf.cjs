const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const leads = await p.lead.findMany({
    where: { type: "HEALTHCARE", evidence: { contains: ".pdf" } },
    select: { companyName: true, evidence: true },
    take: 20,
  });
  for (const l of leads) {
    const m = (l.evidence || "").match(/https?:\/\/[^\s\]]+\.pdf/i);
    if (m) console.log(`${l.companyName} => ${m[0]}`);
  }
  await p.$disconnect();
})();
