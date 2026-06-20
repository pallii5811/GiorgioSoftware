import type { Region } from "./discovery";
import {
  scrapeMapsCategoryCity,
  lookupBusinessOnMaps,
  type MapsLookupOptions,
  type MapsPlace,
} from "./playwright-maps";
import { getRegionCities, HEALTHCARE_MAP_QUERIES, isMapsSignificantCity } from "./region-cities";

export type { MapsPlace };

function mapsOsmId(place: MapsPlace): string {
  const key = `${place.name}|${place.city}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `gmaps/${key.slice(0, 120)}`;
}

export interface MapsDiscoveryResult {
  places: MapsPlace[];
  /** Comuni la cui scansione Maps è considerata affidabile (offset avanza solo su questi). */
  citiesScanned: string[];
  queriesRun: number;
  citiesTotal: number;
}

/** Comuni processati in parallelo — 1 evita rate-limit Google su sessioni condivise. */
const CITY_CONCURRENCY = Number(process.env.MAPS_CITY_CONCURRENCY || 1);
/** Budget massimo per singolo comune. */
const CITY_BUDGET_MS = Number(process.env.MAPS_CITY_BUDGET_MS || 55_000);
/** Pausa tra query sullo stesso comune. */
const QUERY_GAP_MS = Number(process.env.MAPS_QUERY_GAP_MS || 900);

export async function discoverFromMaps(
  region: Region,
  opts: { deadline: number; maxPerCity?: number; cityOffset?: number; maxCities?: number }
): Promise<MapsDiscoveryResult> {
  const cities = await getRegionCities(region);
  const maxPerCity = opts.maxPerCity ?? 50;
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
    let totalResults = 0;
    let queriesAttempted = 0;

    for (let qi = 0; qi < HEALTHCARE_MAP_QUERIES.length; qi++) {
      const category = HEALTHCARE_MAP_QUERIES[qi];
      if (Date.now() >= cityDeadline) break;
      queriesAttempted++;
      queriesRun++;

      let batch: MapsPlace[] = [];
      try {
        // MIRAX: ogni query su sessione pulita — altrimenti RSA/poliambulatorio → 0 dopo "casa di cura"
        batch = await scrapeMapsCategoryCity(category, city, maxPerCity, cityDeadline, {
          freshPage: true,
        });
        if (batch.length === 0 && isMapsSignificantCity(region, city)) {
          await new Promise((r) => setTimeout(r, QUERY_GAP_MS));
          batch = await scrapeMapsCategoryCity(category, city, maxPerCity, cityDeadline, {
            freshPage: true,
          });
        }
      } catch (err) {
        console.warn(
          `Maps ${city}/${category}:`,
          err instanceof Error ? err.message : String(err)
        );
        continue;
      }

      totalResults += batch.length;
      for (const p of batch) {
        const k = mapsOsmId(p);
        if (seen.has(k)) continue;
        seen.add(k);
        places.push(p);
      }

      if (Date.now() < cityDeadline) {
        await new Promise((r) => setTimeout(r, QUERY_GAP_MS));
      }
    }

    if (queriesAttempted === 0) return;

    // Comune importante con 0 risultati = scraper fallito, NON segnare come "fatto".
    if (isMapsSignificantCity(region, city) && totalResults === 0) {
      console.warn(`Maps: ${city} — 0 risultati su comune significativo, rimesso in coda`);
      return;
    }

    citiesScanned.push(city);
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
