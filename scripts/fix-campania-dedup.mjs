import { PrismaClient } from "@prisma/client";
import { dedupeRegionByWebsite } from "../src/lib/sanita/lead-dedup.ts";

const p = new PrismaClient();
const region = process.argv[2] || "Campania";

const removed = await dedupeRegionByWebsite(region);
console.log("deduped", removed);

const reset = await p.lead.updateMany({
  where: { region, website: { contains: "villadeifioriacerra" } },
  data: {
    lastScannedAt: null,
    policyFound: false,
    policyCompany: null,
    policyMassimale: null,
    policyNumber: null,
    policyExpiry: null,
    confidence: null,
    evidence: null,
    leadScore: 0,
    pagesVisited: 0,
  },
});
console.log("reset villadeifioriacerra", reset.count);

const total = await p.lead.count({ where: { type: "HEALTHCARE", region } });
const done = await p.lead.count({
  where: { type: "HEALTHCARE", region, lastScannedAt: { not: null } },
});
console.log("stats", { total, done });

await p.$disconnect();
