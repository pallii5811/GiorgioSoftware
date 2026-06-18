import { prisma } from "../src/lib/sanita/db-ready.ts";
import { parseEvidenceSections } from "../src/lib/sanita/audit.ts";

const region = process.argv[2] ?? "Campania";
const leads = await prisma.lead.findMany({
  where: { region, evidence: { startsWith: "[V:PUB]" } },
  select: { companyName: true, evidence: true },
});

for (const l of leads) {
  const { body, docs } = parseEvidenceSections(l.evidence);
  console.log("---", l.companyName);
  console.log("DOCS", docs?.length ? docs : "MISSING");
  console.log("body", (body ?? "").slice(0, 140));
}

await prisma.$disconnect();
