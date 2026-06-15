import { prisma } from "../src/lib/prisma.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";

const SUSPECT =
  /scuola|albergo|hotel|ristorant|pizzeria|lilt|lega italiana|basilic|museo|chiesa|parrocch|tabacch|palestra|autofficin|immobiliar|banca|agenzia viagg|distretto|asl\b|ulss\b|poliambulatorio generico/i;

const leads = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", lastScannedAt: { not: null } },
  select: { companyName: true, region: true, category: true, evidence: true, osmId: true },
});

const suspects = [];
const bySource = { maps: 0, salute: 0, other: 0 };

for (const l of leads) {
  if (l.osmId?.startsWith("gmaps/")) bySource.maps++;
  else if (l.osmId?.startsWith("min-salute/")) bySource.salute++;
  else bySource.other++;

  if (SUSPECT.test(l.companyName) || SUSPECT.test(l.category ?? "")) {
    suspects.push({
      name: l.companyName,
      region: l.region,
      category: l.category,
      verdict: readVerdictToken(l.evidence),
      source: l.osmId?.split("/")[0],
    });
  }
}

console.log("Analizzati:", leads.length);
console.log("Fonte:", bySource);
console.log("Sospetti fuori target:", suspects.length);
for (const s of suspects) console.log(" ", s);

await prisma.$disconnect();
