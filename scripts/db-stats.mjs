import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const region = process.argv[2] ?? "Campania";

const total = await p.lead.count({ where: { type: "HEALTHCARE", region } });
const hot = await p.lead.count({
  where: { type: "HEALTHCARE", region, evidence: { startsWith: "[V:HOT]" } },
});
const pub = await p.lead.count({
  where: { type: "HEALTHCARE", region, evidence: { startsWith: "[V:PUB]" } },
});
const rev = await p.lead.count({
  where: { type: "HEALTHCARE", region, evidence: { startsWith: "[V:REV]" } },
});
const nullEv = await p.lead.count({
  where: {
    type: "HEALTHCARE",
    region,
    OR: [{ evidence: null }, { evidence: "" }],
  },
});
const scanned = await p.lead.count({
  where: { type: "HEALTHCARE", region, lastScannedAt: { not: null } },
});

console.log(JSON.stringify({ region, total, hot, pub, rev, nullEv, scanned }, null, 2));
await p.$disconnect();
