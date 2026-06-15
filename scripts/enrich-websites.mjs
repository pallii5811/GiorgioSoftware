/**
 * Cerca siti mancanti su Google Maps + Tavily (OSM/Min.Salute non li hanno).
 * npm run enrich:websites
 */
import { prisma, ensureSqliteWal } from "../src/lib/sanita/db-ready.ts";
import { bulkEnrichMissingWebsites } from "../src/lib/sanita/website-enrichment.ts";
import { closeMapsBrowserPool } from "../src/lib/sanita/playwright-maps.ts";

// I dati sono già salvati per-lead: errori di shutdown del pool Playwright non devono
// far fallire lo script (in passato exit -1 dopo l'ultimo lead).
process.on("uncaughtException", (e) => console.warn("  [shutdown]", String(e).slice(0, 80)));
process.on("unhandledRejection", (e) => console.warn("  [shutdown]", String(e).slice(0, 80)));

const REGIONS = (process.env.ENRICH_REGION || "Campania,Veneto")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const CONCURRENCY = Number(process.env.ENRICH_CONCURRENCY || 3);

await ensureSqliteWal();

for (const region of REGIONS) {
  const missing = await prisma.lead.count({
    where: { type: "HEALTHCARE", region, OR: [{ website: null }, { website: "" }] },
  });
  const total = await prisma.lead.count({ where: { type: "HEALTHCARE", region } });
  console.log(`  ${region}: ${missing}/${total} senza sito in anagrafica → ricerca Maps/Tavily`);
}

console.log(`\n🔎 ARRICCHIMENTO SITI (×${CONCURRENCY} parallelo)\n`);

let found = 0;
try {
  ({ found } = await bulkEnrichMissingWebsites(REGIONS, {
    concurrency: CONCURRENCY,
    onProgress: (p) => {
      if (p.done % 10 === 0 || p.done === p.total) {
        console.log(`  … ${p.region} ${p.done}/${p.total} (${p.found} siti trovati)`);
      }
    },
  }));
} catch (e) {
  console.warn("  ⚠️ Arricchimento interrotto:", String(e).slice(0, 80));
}

const stillMissing = await prisma.lead.count({
  where: {
    type: "HEALTHCARE",
    region: { in: REGIONS },
    OR: [{ website: null }, { website: "" }],
  },
});

console.log(`\n✅ ${found} siti aggiunti | ancora senza sito: ${stillMissing}\n`);
await closeMapsBrowserPool().catch(() => {});
await prisma.$disconnect().catch(() => {});
process.exit(0);
