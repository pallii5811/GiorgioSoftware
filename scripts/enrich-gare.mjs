/**
 * Arricchisce contatti + fonti per gare già in DB.
 * Uso: npx tsx scripts/enrich-gare.mjs [Campania|Veneto]
 */
import { PrismaClient } from "@prisma/client";

const region = process.argv[2];
const prisma = new PrismaClient();
const { enrichTenderBatch } = await import("../src/lib/gare/enrich.ts");

const where = {
  type: "TENDER",
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

console.log(`Arricchimento ${items.length} gare…`);
const stats = await enrichTenderBatch(items, 4);
console.log(`✓ ${stats.enriched} arricchite | tel=${stats.withPhone} email=${stats.withEmail}`);
await prisma.$disconnect();
