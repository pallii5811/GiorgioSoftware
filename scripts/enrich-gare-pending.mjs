/** Arricchisce solo gare senza lastScannedAt (evita rilavoro inutile). */
import { prisma } from "../src/lib/sanita/db-ready.ts";
import { enrichTenderBatch } from "../src/lib/gare/enrich.ts";

const region = process.argv[2];
const where = {
  type: "TENDER",
  lastScannedAt: null,
  ...(region && ["Campania", "Veneto"].includes(region) ? { region } : {}),
};

const leads = await prisma.lead.findMany({
  where,
  select: {
    id: true,
    companyName: true,
    region: true,
    tenderCig: true,
    tenderObject: true,
    tenderAmount: true,
    evidence: true,
  },
});

const yearMatch = (e) => e?.match(/ANAC (\d{4})/);
const items = leads.map((l) => ({
  id: l.id,
  companyName: l.companyName,
  region: l.region,
  meta: {
    year: Number(yearMatch(l.evidence)?.[1] ?? new Date().getFullYear()),
    cig: l.tenderCig ?? "?",
    object: l.tenderObject ?? "Appalto pubblico",
    buyer: null,
    amount: l.tenderAmount ?? 0,
  },
}));

console.log(`Arricchimento pendenti: ${items.length}${region ? ` (${region})` : ""}`);
if (items.length === 0) {
  await prisma.$disconnect();
  process.exit(0);
}

const stats = await enrichTenderBatch(items, 4);
console.log(`✓ ${stats.enriched} | tel=${stats.withPhone} email=${stats.withEmail}`);
await prisma.$disconnect();
