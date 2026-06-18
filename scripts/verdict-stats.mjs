import { prisma } from "../src/lib/sanita/db-ready.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";

const leads = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", evidence: { not: null } },
  select: { region: true, evidence: true },
});

const by = {};
for (const l of leads) {
  const v = readVerdictToken(l.evidence) || "?";
  const k = `${l.region}:${v}`;
  by[k] = (by[k] || 0) + 1;
}
console.log("VERDICT COUNTS", JSON.stringify(by, null, 2));
console.log("TOTAL", leads.length);
