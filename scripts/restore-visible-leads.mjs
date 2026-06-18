import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const region = process.argv[2] ?? "Campania";

const nullScan = await p.lead.count({
  where: { type: "HEALTHCARE", region, lastScannedAt: null },
});
const nullWithEvidence = await p.lead.count({
  where: {
    type: "HEALTHCARE",
    region,
    lastScannedAt: null,
    evidence: { not: null },
  },
});

console.log({ nullScan, nullWithEvidence });

if (process.argv.includes("--fix")) {
  const r = await p.lead.updateMany({
    where: {
      type: "HEALTHCARE",
      region,
      lastScannedAt: null,
      evidence: { not: null },
    },
    data: { lastScannedAt: new Date() },
  });
  console.log("restored lastScannedAt:", r.count);
}

await p.$disconnect();
