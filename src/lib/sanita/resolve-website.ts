import type { Region } from "@/lib/sanita/discovery";
import { normalizeWebsite } from "@/lib/sanita/discovery";
import { findOfficialWebsite } from "@/lib/sanita/contact-enrichment";
import { resolveWebsiteViaMaps } from "@/lib/sanita/maps-discovery";
import { extractCityFromMapsAddress, mapsMatchScore } from "@/lib/sanita/maps-query";

export type WebsiteSource = "maps-card" | "maps-lookup" | "google" | null;

export type WebsiteResolution = {
  website: string | null;
  companyName: string;
  city: string | null;
  phone: string | null;
  source: WebsiteSource;
  googleTried: boolean;
};

/**
 * Trova il sito ufficiale di una struttura — come un utente su Google:
 * 1) scheda Maps (se già nota dalla scoperta)
 * 2) ricerca Maps per nome+comune
 * 3) ricerca Google web (Tavily) "sito ufficiale"
 */
export async function resolveOfficialWebsite(
  name: string,
  city: string | null,
  region: Region,
  opts?: {
    deadline?: number;
    /** Sito dalla scheda Maps in fase discovery — fidato, niente match OSM. */
    mapsCardWebsite?: string | null;
    mapsCardTrusted?: boolean;
  }
): Promise<WebsiteResolution> {
  const deadline = opts?.deadline ?? Date.now() + 60_000;
  let companyName = name;
  let resolvedCity = city;
  let phone: string | null = null;
  let website: string | null = null;
  let source: WebsiteSource = null;
  let googleTried = false;

  if (opts?.mapsCardTrusted && opts.mapsCardWebsite) {
    const w = normalizeWebsite(opts.mapsCardWebsite);
    if (w) {
      return {
        website: w,
        companyName,
        city: resolvedCity,
        phone,
        source: "maps-card",
        googleTried: false,
      };
    }
  }

  if (Date.now() < deadline) {
    const maps = await resolveWebsiteViaMaps(name, city, region, {
      deadline,
      maxQueries: 6,
    });
    if (maps) {
      const score = mapsMatchScore(name, maps.name);
      if (score >= 0) {
        companyName = maps.name;
        if (maps.phone) phone = maps.phone;
        const mapsCity = extractCityFromMapsAddress(maps.address);
        if (mapsCity) resolvedCity = mapsCity;
        if (maps.website && score >= 4) {
          website = normalizeWebsite(maps.website);
          source = "maps-lookup";
        }
      }
    }
  }

  if (!website && Date.now() < deadline) {
    googleTried = true;
    const google = await findOfficialWebsite(companyName, resolvedCity, region);
    const w = normalizeWebsite(google.website ?? undefined);
    if (w) {
      website = w;
      source = "google";
    }
  }

  return { website, companyName, city: resolvedCity, phone, source, googleTried };
}
