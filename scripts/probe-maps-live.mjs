/**
 * Probe diagnostico: verifica che Google Maps scrapi davvero (read-only, nessuna scrittura DB).
 * Uso: npx tsx scripts/probe-maps-live.mjs Campania [cityOffset]
 */
import { discoverFromMaps } from "../src/lib/sanita/maps-discovery.ts";
import { closeMapsBrowserPool } from "../src/lib/sanita/playwright-maps.ts";
import { getRegionCities } from "../src/lib/sanita/region-cities.ts";

const region = process.argv[2] === "Veneto" ? "Veneto" : "Campania";
const cityOffset = Number(process.argv[3] || 0);

const cities = await getRegionCities(region);
console.log(`Regione ${region}: ${cities.length} comuni in lista. Provo 2 comuni da offset ${cityOffset}.`);
console.log(`Primi comuni: ${cities.slice(cityOffset, cityOffset + 2).join(", ")}`);

const deadline = Date.now() + 60_000;
const t0 = Date.now();
const r = await discoverFromMaps(region, { deadline, cityOffset, maxPerCity: 8, maxCities: 2 });
const sec = ((Date.now() - t0) / 1000).toFixed(0);

console.log(`\nRISULTATO in ${sec}s:`);
console.log(`  strutture trovate: ${r.places.length}`);
console.log(`  comuni scansionati: ${r.citiesScanned.join(", ") || "(nessuno)"}`);
console.log(`  query eseguite: ${r.queriesRun}`);
for (const p of r.places.slice(0, 6)) {
  console.log(`   - ${p.name} | ${p.city} | ${p.website || "(no sito)"}`);
}

await closeMapsBrowserPool().catch(() => {});
process.exit(0);
