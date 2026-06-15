import { parseContactsFromText, pickOfficialWebsite, type ParsedContacts } from "./contacts";
import { mapsPrimaryName } from "./maps-query";
import { lookupBusinessOnMaps } from "./playwright-maps";
import { tavilySearch, type TavilyHit } from "./tavily-client";

export interface ContactEnrichmentResult {
  contacts: ParsedContacts;
  checked: boolean;
  sourceUrls: string[];
  usedMaps: boolean;
}

/** Cerca telefono, email, PEC e sito per strutture senza contatti completi. */
export async function enrichContacts(
  name: string,
  city: string | null,
  region: string,
  opts?: { skipMaps?: boolean }
): Promise<ContactEnrichmentResult> {
  const base = mapsPrimaryName(name).replace(/srl|spa|s\.p\.a\.?|s\.r\.l\.?/gi, "").trim();
  const cityPart = city ? ` ${city}` : "";

  const queries = [
    `"${base}"${cityPart} sito ufficiale`,
    `"${base}"${cityPart} ${region} casa di cura sito web`,
    `"${base}"${cityPart} telefono email PEC contatti`,
  ];

  const hits = (await Promise.all(queries.map((q) => tavilySearch(q, { maxResults: 5 })))).flat();
  let contacts: ParsedContacts = { emails: [], pec: null, phones: [], website: null };
  let sourceUrls: string[] = [];
  let checked = false;
  let usedMaps = false;

  if (hits.length > 0) {
    const text = hits.map((h) => `${h.content} ${h.url}`).join("\n");
    const parsed = parseContactsFromText(text);
    const fromHits = pickOfficialWebsite(
      hits.map((h) => h.url).filter(Boolean),
      name
    );
    contacts = { ...parsed, website: fromHits || parsed.website };
    sourceUrls = hits.map((h) => h.url).filter(Boolean);
    checked = true;
  }

  // Google Maps Playwright (MIRAX) se ancora senza sito
  if (!contacts.website && !opts?.skipMaps) {
    const maps = await lookupBusinessOnMaps(name, city, region);
    if (maps) {
      usedMaps = true;
      checked = true;
      if (maps.website) contacts.website = maps.website;
      if (maps.phone) contacts.phones = [maps.phone, ...contacts.phones];
      sourceUrls = [...sourceUrls, "https://www.google.com/maps"];
    }
  }

  return { contacts, checked, sourceUrls, usedMaps };
}

/** Solo ricerca sito ufficiale (veloce, per strutture Min. Salute senza URL). */
export async function findOfficialWebsite(
  name: string,
  city: string | null,
  region: string
): Promise<{ website: string | null; sourceUrls: string[] }> {
  const base = mapsPrimaryName(name).replace(/srl|spa|s\.p\.a\.?|s\.r\.l\.?/gi, "").trim();
  const cityPart = city ? ` ${city}` : "";
  const q = `"${base}"${cityPart} ${region} sito ufficiale casa di cura`;
  const hits: TavilyHit[] = await tavilySearch(q, { maxResults: 6 });
  const urls = hits.map((h) => h.url).filter(Boolean);
  return {
    website: pickOfficialWebsite(urls, name),
    sourceUrls: urls,
  };
}
