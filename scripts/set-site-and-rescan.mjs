import { prisma } from "../src/lib/sanita/db-ready.ts";
import { analyzeLead } from "../src/lib/sanita/scan-engine.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";
import { terminateOcrWorker } from "../src/lib/sanita/ocr.ts";
import { closeMapsBrowserPool } from "../src/lib/sanita/playwright-maps.ts";

process.env.POLICY_EXHAUSTIVE = "1";
process.env.OCR_ENABLED = "1";

const q = process.argv[2];
const site = process.argv[3];
if (!q || !site) {
  console.error("Usage: npx tsx scripts/set-site-and-rescan.mjs <name-fragment> <website>");
  process.exit(1);
}

const lead = await prisma.lead.findFirst({ where: { companyName: { contains: q } } });
if (!lead) {
  console.error("LEAD_NOT_FOUND", q);
  process.exit(1);
}

await prisma.lead.update({
  where: { id: lead.id },
  data: { website: site, lastScannedAt: null },
});

const fresh = await prisma.lead.findUnique({ where: { id: lead.id } });
console.log("BEFORE", fresh?.companyName, readVerdictToken(fresh?.evidence), fresh?.website);

const counters = { analyzed: 0, withPolicy: 0, hot: 0, review: 0 };
// analyzeLead richiede region nella shape input
await analyzeLead({ ...fresh, region: fresh.region }, counters);

const after = await prisma.lead.findUnique({ where: { id: lead.id } });
console.log("AFTER", after?.companyName, readVerdictToken(after?.evidence), after?.policyCompany);
console.log("EVIDENCE_HEAD", (after?.evidence || "").slice(0, 220));

await terminateOcrWorker().catch(() => {});
await closeMapsBrowserPool().catch(() => {});
