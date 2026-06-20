import { PrismaClient } from "@prisma/client";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";

const p = new PrismaClient();
const region = "Campania";
const leads = await p.lead.findMany({
  where: { type: "HEALTHCARE", region },
  select: { status: true, website: true, lastScannedAt: true, leadScore: true, policyFound: true, evidence: true },
});
const verdicts = {};
let noWebsite = 0;
for (const l of leads) {
  const v = readVerdictToken(l.evidence) ?? (l.policyFound ? "PUBLISHED" : "REVIEW");
  verdicts[v] = (verdicts[v] ?? 0) + 1;
  if (!l.website) noWebsite++;
}
console.log(
  JSON.stringify(
    { total: leads.length, verdicts, noWebsite, scanned: leads.filter((l) => l.lastScannedAt).length },
    null,
    2
  )
);
await p.$disconnect();
