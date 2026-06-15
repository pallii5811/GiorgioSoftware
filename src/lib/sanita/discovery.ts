import { externalFetch } from "@/lib/http";
import { normalizeOfficialWebsite } from "@/lib/sanita/website";

export type Region = "Veneto" | "Campania";

export interface Facility {
  osmId: string;
  name: string;
  website: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  category: string;
  lat: number | null;
  lon: number | null;
}

// Codici ISO 3166-2 delle regioni italiane
const REGION_ISO: Record<Region, string> = {
  Veneto: "IT-34",
  Campania: "IT-72",
};

// Mirror Overpass (il principale a volte risponde 406; usiamo fallback)
const OVERPASS_ENDPOINTS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
];

/**
 * Costruisce la query Overpass QL per trovare strutture sociosanitarie:
 * RSA, case di riposo, case di cura, cliniche private.
 */
function facilitySelectors(area: string): string {
  return `
  nwr["amenity"="nursing_home"](${area});
  nwr["social_facility"="nursing_home"](${area});
  nwr["social_facility"="assisted_living"](${area});
  nwr["social_facility"="group_home"](${area});
  nwr["healthcare"="clinic"](${area});
  nwr["amenity"="clinic"](${area});
  nwr["healthcare"="hospital"]["operator:type"="private"](${area});`;
}

function buildQuery(iso: string): string {
  return `
[out:json][timeout:90];
area["ISO3166-2"="${iso}"]->.r;
(
${facilitySelectors("area.r")}
);
out center tags;
`;
}

function buildBBoxQuery(region: Region): string {
  const [south, west, north, east] = REGION_BBOX[region];
  return `
[out:json][timeout:90];
(
${facilitySelectors(`${south},${west},${north},${east}`)}
);
out center tags;
`;
}

function parseOverpassElements(elements: OverpassElement[]): Facility[] {
  const facilities = elements
    .map((el): Facility | null => {
      const tags = el.tags ?? {};
      const name = tags.name?.trim();
      if (!name) return null;

      const lat = el.lat ?? el.center?.lat ?? null;
      const lon = el.lon ?? el.center?.lon ?? null;

      return {
        osmId: `${el.type}/${el.id}`,
        name,
        website: normalizeWebsite(tags.website || tags["contact:website"]),
        city: tags["addr:city"] || null,
        phone: tags.phone || tags["contact:phone"] || null,
        email: tags.email || tags["contact:email"] || null,
        category: classify(tags),
        lat,
        lon,
      };
    })
    .filter((f): f is Facility => f !== null);

  const seen = new Set<string>();
  return facilities.filter((f) => {
    const key = `${f.name.toLowerCase()}|${(f.city || "").toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function overpassFailed(json: OverpassResponse): string | null {
  if (json.error) return json.error;
  if (json.remark && /error|timeout|too busy|dispatcher/i.test(json.remark)) return json.remark;
  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queryOverpassOnce(endpoint: string, query: string): Promise<Facility[] | null> {
  const res = await externalFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(query),
    timeoutMs: 45_000,
  });

  if (!res.ok) {
    throw new Error(`Overpass ${endpoint} ha risposto ${res.status}`);
  }

  const json = (await res.json()) as OverpassResponse;
  const fail = overpassFailed(json);
  if (fail) throw new Error(fail);

  const elements = json.elements ?? [];
  if (elements.length === 0) return null;

  return parseOverpassElements(elements);
}

/** Fino a 3 tentativi con backoff — Overpass è spesso intermittente. */
async function queryOverpass(endpoint: string, query: string): Promise<Facility[] | null> {
  const delays = [0, 2_500, 5_000];
  let lastErr: unknown = null;
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    try {
      return await queryOverpassOnce(endpoint, query);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
  remark?: string;
  error?: string;
}

// Bounding box [south, west, north, east] — fallback se la query per area ISO fallisce
const REGION_BBOX: Record<Region, [number, number, number, number]> = {
  Veneto: [44.75, 10.65, 46.75, 13.15],
  Campania: [39.85, 13.75, 41.55, 15.85],
};

function classify(tags: Record<string, string>): string {
  if (tags["social_facility"] === "nursing_home" || tags["amenity"] === "nursing_home")
    return "RSA / Casa di riposo";
  if (tags["social_facility"] === "assisted_living") return "Residenza assistita";
  if (tags["social_facility"] === "group_home") return "Comunità alloggio";
  if (tags["healthcare"] === "hospital") return "Casa di cura privata";
  if (tags["healthcare"] === "clinic" || tags["amenity"] === "clinic") return "Clinica / Poliambulatorio";
  return "Struttura sociosanitaria";
}

export function normalizeWebsite(raw: string | undefined | null): string | null {
  return normalizeOfficialWebsite(raw);
}

/**
 * Interroga Overpass e restituisce le strutture trovate nella regione.
 * Prova più mirror in sequenza per massima affidabilità.
 */
const DISCOVERY_BUDGET_MS = 90_000;

export async function discoverFacilities(region: Region): Promise<Facility[]> {
  const iso = REGION_ISO[region];
  const queries = [buildQuery(iso), buildBBoxQuery(region)];
  const deadline = Date.now() + DISCOVERY_BUDGET_MS;

  let lastError: unknown = null;

  for (const query of queries) {
    for (const endpoint of OVERPASS_ENDPOINTS) {
      if (Date.now() >= deadline) {
        lastError = new Error("timeout discovery Overpass (90s)");
        break;
      }
      try {
        const facilities = await queryOverpass(endpoint, query);
        if (facilities && facilities.length > 0) return facilities;
        lastError = new Error(`Overpass ${endpoint}: risposta vuota`);
      } catch (err) {
        lastError = err;
      }
    }
    if (Date.now() >= deadline) break;
  }

  throw new Error(
    `Impossibile interrogare Overpass su tutti i mirror. Ultimo errore: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}
