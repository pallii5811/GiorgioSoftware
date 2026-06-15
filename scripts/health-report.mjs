import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

const hc = await p.lead.count({ where: { type: "HEALTHCARE" } });
const hScanned = await p.lead.count({ where: { type: "HEALTHCARE", lastScannedAt: { not: null } } });
const hSite = await p.lead.count({ where: { type: "HEALTHCARE", website: { not: null } } });
const hAudit = await p.lead.count({ where: { type: "HEALTHCARE", evidence: { contains: "[FONTI:" } } });
const hHot = await p.lead.count({ where: { type: "HEALTHCARE", evidence: { startsWith: "[V:HOT]" } } });

const tg = await p.lead.count({ where: { type: "TENDER" } });
const tPhone = await p.lead.count({ where: { type: "TENDER", phone: { not: null } } });
const tEmail = await p.lead.count({ where: { type: "TENDER", OR: [{ email: { not: null } }, { pec: { not: null } }] } });
const tAudit = await p.lead.count({ where: { type: "TENDER", evidence: { contains: "[FONTI:" } } });

const pineta = await p.lead.findFirst({
  where: { companyName: { contains: "Pineta Grande" } },
  select: { website: true, evidence: true },
});

console.log("\n=== HEALTH REPORT ===\n");
console.log("SANITÀ:", { total: hc, scanned: hScanned, withSite: hSite, withAudit: hAudit, hot: hHot });
console.log("GARE:", { total: tg, withPhone: tPhone, withEmail: tEmail, withAudit: tAudit });
console.log("Pineta:", pineta);
console.log("");
await p.$disconnect();
