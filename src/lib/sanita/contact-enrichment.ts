import {
  parseContactsFromText,
  pickOfficialWebsite,
  pickOfficialWebsiteFromHits,
  type ParsedContacts,
} from "./contacts";
import { mapsFacilitySearchName, mapsSubsidiaryName } from "./maps-query";
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
  const base = mapsFacilitySearchName(name).replace(/srl|spa|s\.p\.a\.?|s\.r\.l\.?/gi, "").trim();
  const cityPart = city ? ` ${city}` : "";
  const subsidiary = mapsSubsidiaryName(name);

  const queries = [
    `"${base}"${cityPart} sito ufficiale`,
    `"${base}"${cityPart} ${region} casa di cura sito web`,
    `"${base}"${cityPart} telefono email PEC contatti`,
  ];
  if (subsidiary && subsidiary !== base) {
    queries.unshift(`"${subsidiary}"${cityPart} sito ufficiale`);
    queries.unshift(`${subsidiary}${cityPart} casa di cura clinica`);
  }

  const hits = (
    await Promise.all(queries.map((q) => tavilySearch(q, { maxResults: 6, depth: "advanced" })))
  ).flat();
  let contacts: ParsedContacts = { emails: [], pec: null, phones: [], website: null };
  let sourceUrls: string[] = [];
  let checked = false;
  let usedMaps = false;

  if (hits.length > 0) {
    const text = hits.map((h) => `${h.content} ${h.url}`).join("\n");
    const parsed = parseContactsFromText(text);
    const fromHits =
      pickOfficialWebsiteFromHits(hits, name) ||
      pickOfficialWebsite(
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
  const base = mapsFacilitySearchName(name).replace(/srl|spa|s\.p\.a\.?|s\.r\.l\.?/gi, "").trim();
  const cityPart = city ? ` ${city}` : "";
  const subsidiary = mapsSubsidiaryName(name);
  const queries = [
    `"${base}"${cityPart} sito ufficiale`,
    `${base}${cityPart} ${region} casa di cura clinica rsa`,
    `${base}${cityPart} sito web`,
  ];
  if (subsidiary && subsidiary !== base) {
    queries.unshift(`"${subsidiary}"${cityPart} sito ufficiale`);
  }
  const hits: TavilyHit[] = (
    await Promise.all(queries.map((q) => tavilySearch(q, { maxResults: 6, depth: "advanced" })))
  ).flat();
  const urls = hits.map((h) => h.url).filter(Boolean);
  return {
    website:
      pickOfficialWebsiteFromHits(hits, name) || pickOfficialWebsite(urls, name),
    sourceUrls: urls,
  };
}
