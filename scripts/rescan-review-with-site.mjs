/**
 * Rimette in coda lead con sito bloccati in REVIEW per timeout o sito scartato dal filtro.
 * Uso: DATABASE_URL=... npx tsx scripts/rescan-review-with-site.mjs Campania
 */
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const region = process.argv[2] || "Campania";
const dry = process.argv.includes("--dry");

const leads = await p.lead.findMany({
  where: {
    type: "HEALTHCARE",
    region,
    website: { not: null },
    NOT: { website: "" },
    lastScannedAt: { not: null },
    evidence: { contains: "[V:REV]" },
  },
  select: { id: true, companyName: true, evidence: true, pagesVisited: true },
});

const toReset = leads.filter((l) => {
  const body = (l.evidence ?? "").replace(/^\[V:REV\]\s*/, "");
  if (/Timeout|Blocco tecnico analisi oltre/i.test(body)) return true;
  if (/Sito ufficiale non individuato/i.test(body)) return true;
  if (/Sito irraggiungibile.*pages: 0/i.test(body) && (l.pagesVisited ?? 0) === 0) return true;
  if (/Sito irraggiungibile/i.test(body) && (l.pagesVisited ?? 0) === 0) return true;
  return false;
});

console.log(JSON.stringify({ candidates: leads.length, toReset: toReset.length, dry }, null, 2));
for (const l of toReset.slice(0, 20)) {
  console.log(`- ${l.companyName} (pages ${l.pagesVisited ?? 0})`);
}

if (!dry && toReset.length > 0) {
  const res = await p.lead.updateMany({
    where: { id: { in: toReset.map((l) => l.id) } },
    data: {
      lastScannedAt: null,
      evidence: null,
      leadScore: 0,
      websiteReachable: null,
      pagesVisited: 0,
    },
  });
  console.log(`Reset ${res.count} lead in coda analisi.`);
}

await p.$disconnect();
