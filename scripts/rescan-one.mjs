/** Rescan singolo lead per nome: npx tsx scripts/rescan-one.mjs Montevergine */
process.env.POLICY_EXHAUSTIVE = "1";
process.env.OCR_ENABLED = "1";

import { prisma } from "../src/lib/sanita/db-ready.ts";
import { analyzeLead } from "../src/lib/sanita/scan-engine.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";
import { terminateOcrWorker } from "../src/lib/sanita/ocr.ts";
import { closeMapsBrowserPool } from "../src/lib/sanita/playwright-maps.ts";

const q = process.argv[2];
if (!q) {
  console.error("Usage: npx tsx scripts/rescan-one.mjs <name-fragment>");
  process.exit(1);
}

const lead = await prisma.lead.findFirst({
  where: { companyName: { contains: q } },
});
if (!lead) {
  console.error("LEAD_NOT_FOUND:", q);
  process.exit(1);
}

console.log("BEFORE", lead.companyName, readVerdictToken(lead.evidence), lead.website);
const counters = { analyzed: 0, withPolicy: 0, hot: 0, review: 0 };
await analyzeLead(lead, counters);
const after = await prisma.lead.findUnique({ where: { id: lead.id } });
console.log(
  "AFTER",
  after.companyName,
  readVerdictToken(after.evidence),
  after.policyCompany,
  after.policyNumber
);
console.log("EVIDENCE_HEAD", (after.evidence || "").slice(0, 280));

await terminateOcrWorker().catch(() => {});
await closeMapsBrowserPool().catch(() => {});
