import type { Region } from "./discovery";
import {
  scrapeMapsCategoryCity,
  lookupBusinessOnMaps,
  type MapsLookupOptions,
  type MapsPlace,
} from "./playwright-maps";
import { getRegionCities, HEALTHCARE_MAP_QUERIES } from "./region-cities";

export type { MapsPlace };

function mapsOsmId(place: MapsPlace): string {
  const key = `${place.name}|${place.city}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `gmaps/${key.slice(0, 120)}`;
}

export interface MapsDiscoveryResult {
  places: MapsPlace[];
  citiesScanned: string[];
  queriesRun: number;
  citiesTotal: number;
}

/**
 * Scoperta strutture via Google Maps (motore MIRAX).
 * Rispetta un budget tempo: scansiona N città per richiesta.
 */
/** Comuni processati in parallelo (×N città × M query ≤ MAPS_POOL_SIZE pagine). */
const CITY_CONCURRENCY = Number(process.env.MAPS_CITY_CONCURRENCY || 2);
/** Budget massimo per singolo comune: evita che una città lenta blocchi il chunk. */
const CITY_BUDGET_MS = Number(process.env.MAPS_CITY_BUDGET_MS || 55_000);

export async function discoverFromMaps(
  region: Region,
  opts: { deadline: number; maxPerCity?: number; cityOffset?: number; maxCities?: number }
): Promise<MapsDiscoveryResult> {
  const cities = await getRegionCities(region);
  const maxPerCity = opts.maxPerCity ?? 12;
  const maxCities = opts.maxCities ?? 999;
  const offset = opts.cityOffset ?? 0;
  const places: MapsPlace[] = [];
  const seen = new Set<string>();
  let queriesRun = 0;
  const citiesScanned: string[] = [];

  const toProcess = cities.slice(offset, offset + maxCities);
  let nextIdx = 0;

  async function scanCity(city: string) {
    const cityDeadline = Math.min(opts.deadline, Date.now() + CITY_BUDGET_MS);
    const batches = await Promise.all(
      HEALTHCARE_MAP_QUERIES.map((category) =>
        scrapeMapsCategoryCity(category, city, maxPerCity, cityDeadline).catch(() => [])
      )
    );
    queriesRun += HEALTHCARE_MAP_QUERIES.length;
    citiesScanned.push(city);
    for (const batch of batches) {
      for (const p of batch) {
        const k = mapsOsmId(p);
        if (seen.has(k)) continue;
        seen.add(k);
        places.push(p);
      }
    }
  }

  const workers = Array.from({ length: CITY_CONCURRENCY }, async () => {
    while (Date.now() < opts.deadline) {
      const myIdx = nextIdx++;
      if (myIdx >= toProcess.length) break;
      await scanCity(toProcess[myIdx]);
    }
  });
  await Promise.all(workers);

  return { places, citiesScanned, queriesRun, citiesTotal: cities.length };
}

/** Trova sito+telefono per una struttura nota (obbligatorio prima di “nessun sito”). */
export async function resolveWebsiteViaMaps(
  name: string,
  city: string | null,
  region: Region,
  opts?: MapsLookupOptions
): Promise<MapsPlace | null> {
  return lookupBusinessOnMaps(name, city, region, opts);
}

export { mapsOsmId };
