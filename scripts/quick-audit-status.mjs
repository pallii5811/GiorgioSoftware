import { prisma } from "../src/lib/prisma.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";

const leads = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", lastScannedAt: { not: null } },
  select: {
    companyName: true,
    region: true,
    website: true,
    websiteReachable: true,
    pagesVisited: true,
    evidence: true,
  },
});

const v = { HOT: 0, PUB: 0, REV: 0 };
let unreachable = 0;
let lowPages = 0;
let noWebsite = 0;
const suspects = [];

for (const l of leads) {
  const t = readVerdictToken(l.evidence);
  if (t === "HOT") v.HOT++;
  else if (t === "PUBLISHED") v.PUB++;
  else v.REV++;

  const ev = (l.evidence || "").toLowerCase();
  if (!l.website) noWebsite++;
  if (l.websiteReachable === false) {
    unreachable++;
    if (t === "HOT" || t === "PUBLISHED")
      suspects.push({ name: l.companyName, issue: "HOT/PUB ma sito irraggiungibile", t });
  }
  if ((l.pagesVisited ?? 0) < 3 && l.website && l.websiteReachable !== false) lowPages++;
  if (ev.includes("fapc.it") || l.companyName.toLowerCase().includes("lilt"))
    suspects.push({ name: l.companyName, issue: "target/sito sospetto", t });
  if (t === "HOT" && (l.pagesVisited ?? 0) === 0 && l.website)
    suspects.push({ name: l.companyName, issue: "HOT con 0 pagine", t });
}

console.log("Analizzate:", leads.length);
console.log("Verdetti:", v);
console.log("Sito irraggiungibile:", unreachable);
console.log("Senza sito:", noWebsite);
console.log("Crawl <3 pagine:", lowPages);
console.log("Sospetti:", suspects.length);
for (const s of suspects.slice(0, 15)) console.log(" ", s.name, "-", s.issue, `(${s.t})`);

await prisma.$disconnect();
