/** Elenca HOT sospetti (sito irraggiungibile o crawl <3 pagine) per revisione. */
import { prisma } from "../src/lib/sanita/db-ready.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";

const hot = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", evidence: { startsWith: "[V:HOT]" } },
  select: {
    companyName: true,
    region: true,
    city: true,
    website: true,
    websiteReachable: true,
    pagesVisited: true,
    evidence: true,
  },
});

const suspect = hot.filter(
  (l) =>
    (l.website && l.websiteReachable === false) ||
    (l.website && (l.pagesVisited ?? 0) < 3 && !l.evidence?.includes("Portali ASL"))
);

console.log(`\nHOT sospetti: ${suspect.length}\n`);
for (const l of suspect.slice(0, 20)) {
  console.log(`${l.companyName} (${l.region})`);
  console.log(`  sito: ${l.website ?? "—"} | pag: ${l.pagesVisited ?? 0} | reach: ${l.websiteReachable}`);
  console.log(`  ${(l.evidence ?? "").replace(/^\[V:\w+\]\s*/, "").slice(0, 100)}\n`);
}
await prisma.$disconnect();
