import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const r = await p.lead.updateMany({
  where: {
    region: "Campania",
    evidence: { contains: "Analisi oltre" },
  },
  data: {
    lastScannedAt: null,
    evidence: null,
    websiteReachable: null,
    pagesVisited: 0,
    policyFound: false,
    leadScore: 0,
  },
});
console.log("RESET_TIMEOUT_LEADS", r.count);
await p.$disconnect();
