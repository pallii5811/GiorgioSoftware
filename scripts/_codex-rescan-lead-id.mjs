import { prisma } from "../src/lib/sanita/db-ready.ts";
import { analyzeLead } from "../src/lib/sanita/scan-engine.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";
import { terminateOcrWorker } from "../src/lib/sanita/ocr.ts";
import { closeMapsBrowserPool } from "../src/lib/sanita/playwright-maps.ts";

const leadId = process.argv[2];
if (!leadId) throw new Error("lead id required");

const lead = await prisma.lead.findUnique({ where: { id: leadId } });
if (!lead) throw new Error(`lead not found: ${leadId}`);

console.log(JSON.stringify({
  phase: "before",
  id: lead.id,
  companyName: lead.companyName,
  verdict: readVerdictToken(lead.evidence),
  policyCompany: lead.policyCompany,
  policyNumber: lead.policyNumber,
  policyExpiry: lead.policyExpiry,
}, null, 2));

const counters = {
  analyzed: 0,
  withPolicy: 0,
  published: 0,
  hot: 0,
  review: 0,
  reviewHuman: 0,
  retryPending: 0,
  technicalBlocked: 0,
  outOfScope: 0,
  regionalChecked: 0,
  regionalWithPolicy: 0,
};
await analyzeLead(lead, counters);

const after = await prisma.lead.findUnique({ where: { id: leadId } });
console.log(JSON.stringify({
  phase: "after",
  id: after?.id,
  companyName: after?.companyName,
  verdict: readVerdictToken(after?.evidence),
  policyFound: after?.policyFound,
  policyCompany: after?.policyCompany,
  policyNumber: after?.policyNumber,
  policyExpiry: after?.policyExpiry,
  evidenceHead: after?.evidence?.slice(0, 700),
  counters,
}, null, 2));

await Promise.race([
  Promise.all([
    terminateOcrWorker().catch(() => {}),
    closeMapsBrowserPool().catch(() => {}),
    prisma.$disconnect(),
  ]),
  new Promise((resolve) => setTimeout(resolve, 15_000)),
]);
process.exit(0);
