import { prisma } from "../src/lib/prisma.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";

const all = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", lastScannedAt: { not: null } },
});

const hot = all.filter((l) => readVerdictToken(l.evidence) === "HOT");
const certified = hot.filter((l) =>
  /assenza polizza certificata|re-audit rigoroso|tutti i PDF analizzati/i.test(l.evidence || "")
);
const solid = hot.filter(
  (l) =>
    l.website &&
    l.websiteReachable !== false &&
    (l.pagesVisited ?? 0) >= 3 &&
    !/^(asl|aulss|ausl)\b|distretto/i.test(l.companyName)
);
const noSite = hot.filter((l) => !l.website);
const pub = all.filter((l) => readVerdictToken(l.evidence) === "PUBLISHED");
const rev = all.filter((l) => readVerdictToken(l.evidence) === "REVIEW");

console.log("\n═══ CERTIFICAZIONE VERDETTI (onesto) ═══\n");
console.log(`Scansionati:        ${all.length}`);
console.log(`PUBLISHED:          ${pub.length}  (polizza trovata sul sito/portale)`);
console.log(`HOT totale:         ${hot.length}`);
console.log(`  Certificati*:     ${certified.length}  (crawl esaustivo + evidenza esplicita)`);
console.log(`  Sito solido**:    ${solid.length}  (sito OK, ≥3 pagine, non ASL)`);
console.log(`  Senza sito:       ${noSite.length}  (obbligo Art.10, ma non verificabile online)`);
console.log(`REVIEW:             ${rev.length}  (dubbio — né HOT né PUB certificato)`);
console.log("\n* HOT certificato = testo evidenza conferma assenza dopo crawl rigoroso");
console.log("** Stima commerciale — non equivale al 100% legale\n");

await prisma.$disconnect();
