import { prisma } from "../src/lib/sanita/db-ready.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";

const hot = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", evidence: { startsWith: "[V:HOT]" }, lastScannedAt: { not: null } },
  select: {
    companyName: true,
    region: true,
    website: true,
    websiteReachable: true,
    pagesVisited: true,
    policyFound: true,
    evidence: true,
  },
});

// SQLite: evidence doesn't have foundRelevant - use pagesVisited
const junkHosts = /support\.google|carabinieri\.it|facebook\.|instagram\.|linkedin\.|wikipedia\./i;
const aslPublic = /^(asl|aulss|ausl)\b|distretto|poliambulatorio/i;

let noSite = 0;
let unreachable = 0;
let fewPages = 0;
let junkSite = 0;
let publicEntity = 0;
let solid = 0;

for (const l of hot) {
  if (!l.website) {
    noSite++;
    continue;
  }
  if (l.websiteReachable === false) {
    unreachable++;
    continue;
  }
  if (junkHosts.test(l.website)) {
    junkSite++;
    continue;
  }
  if (aslPublic.test(l.companyName)) {
    publicEntity++;
    continue;
  }
  if ((l.pagesVisited ?? 0) < 3) {
    fewPages++;
    continue;
  }
  solid++;
}

console.log(`\nHOT totali scansionati: ${hot.length}`);
console.log(`  Siti solidi (raggiungibile, ≥3 pagine, non ASL/junk): ${solid}`);
console.log(`  Entità ASL/distretto (HOT discutibile): ${publicEntity}`);
console.log(`  Sito junk/errato (Maps): ${junkSite}`);
console.log(`  Crawl superficiale (<3 pagine): ${fewPages}`);
console.log(`  Sito irraggiungibile: ${unreachable}`);
console.log(`  Senza sito: ${noSite}`);
console.log(`\n→ HOT commercialmente utili stimati: ~${solid} su ${hot.length}\n`);

if (junkSite > 0) {
  console.log("Siti junk:");
  for (const l of hot.filter((x) => x.website && junkHosts.test(x.website)).slice(0, 8)) {
    console.log(`  ${l.companyName} → ${l.website}`);
  }
}

await prisma.$disconnect();
