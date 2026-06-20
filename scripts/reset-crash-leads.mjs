import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const region = process.argv[2] || "Campania";

const r = await p.lead.updateMany({
  where: {
    region,
    type: "HEALTHCARE",
    evidence: { contains: "website is not defined" },
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
console.log(JSON.stringify({ region, reset: r.count }, null, 2));
await p.$disconnect();
