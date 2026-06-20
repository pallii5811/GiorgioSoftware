import { scrapeMapsCategoryCity, closeMapsBrowserPool } from "../src/lib/sanita/playwright-maps.ts";
import { HEALTHCARE_MAP_QUERIES } from "../src/lib/sanita/region-cities.ts";

const cities = process.argv.slice(2);
if (cities.length === 0) cities.push("Napoli", "Salerno", "Avellino");

const deadline = Date.now() + 120_000;
for (const city of cities) {
  let total = 0;
  for (const cat of HEALTHCARE_MAP_QUERIES) {
    const r = await scrapeMapsCategoryCity(cat, city, 50, deadline, { freshPage: true }).catch((e) => {
      console.log(`  ERR ${city}/${cat}: ${e.message}`);
      return [];
    });
    total += r.length;
    console.log(`  ${city} · "${cat}" -> ${r.length}`);
  }
  console.log(`== ${city}: ${total} raw places ==`);
}
await closeMapsBrowserPool().catch(() => {});
process.exit(0);
