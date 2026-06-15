import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

const hot = await p.lead.findMany({
  where: { type: "HEALTHCARE", evidence: { startsWith: "[V:HOT]" }, website: { not: null } },
  select: {
    companyName: true,
    region: true,
    city: true,
    website: true,
    category: true,
    policyFound: true,
    websiteReachable: true,
    pagesVisited: true,
    evidence: true,
  },
  take: 15,
  orderBy: { leadScore: "desc" },
});

const hotNoSite = await p.lead.count({
  where: { type: "HEALTHCARE", evidence: { startsWith: "[V:HOT]" }, OR: [{ website: null }, { website: "" }] },
});

const hotReachable = await p.lead.count({
  where: { type: "HEALTHCARE", evidence: { startsWith: "[V:HOT]" }, websiteReachable: true },
});

const hotUnreachable = await p.lead.count({
  where: { type: "HEALTHCARE", evidence: { startsWith: "[V:HOT]" }, websiteReachable: false },
});

const hotAsl = await p.lead.count({
  where: {
    type: "HEALTHCARE",
    evidence: { startsWith: "[V:HOT]" },
    OR: [
      { companyName: { contains: "ASL" } },
      { companyName: { contains: "Azienda Ospedaliera" } },
      { companyName: { contains: "AOU" } },
      { category: { contains: "ospedale pubblico" } },
    ],
  },
});

const hotWithRelevantPage = await p.lead.count({
  where: {
    type: "HEALTHCARE",
    evidence: { startsWith: "[V:HOT]" },
    evidence: { contains: "Trasparenza" },
  },
});

const pub = await p.lead.count({ where: { type: "HEALTHCARE", evidence: { startsWith: "[V:PUB]" } } });

const hotLowPages = await p.lead.count({
  where: {
    type: "HEALTHCARE",
    evidence: { startsWith: "[V:HOT]" },
    website: { not: null },
    OR: [{ pagesVisited: { lte: 2 } }, { pagesVisited: null }],
  },
});

console.log("\n=== AUDIT HOT (possibili falsi positivi) ===\n");
console.log({ hotConSito: hot.length, hotNoSite, hotReachable, hotUnreachable, hotAslPubblico: hotAsl, pub });
console.log("HOT con ≤2 pagine crawlate (crawl superficiale):", hotLowPages);
console.log("HOT con menzione Trasparenza in evidence:", hotWithRelevantPage);
console.log("\nCampione 15 HOT (con sito):\n");
for (const l of hot) {
  const body = (l.evidence || "").replace(/^\[V:HOT\]\s*/, "").slice(0, 120);
  console.log(`• ${l.companyName} (${l.city || "?"})`);
  console.log(`  ${l.website} | pag=${l.pagesVisited ?? 0} | ${body}…\n`);
}

await p.$disconnect();
