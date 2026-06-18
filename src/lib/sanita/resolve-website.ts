import type { Region } from "@/lib/sanita/discovery";
import { normalizeWebsite } from "@/lib/sanita/discovery";
import { pickOfficialWebsite } from "@/lib/sanita/contacts";
import { findOfficialWebsite } from "@/lib/sanita/contact-enrichment";
import { probeGuessedOfficialWebsite } from "@/lib/sanita/guess-website";
import { resolveWebsiteViaMaps } from "@/lib/sanita/maps-discovery";
import {
  extractCityFromMapsAddress,
  mapsFacilitySearchName,
  mapsMatchScore,
} from "@/lib/sanita/maps-query";

export type WebsiteSource = "maps-card" | "maps-lookup" | "google" | null;

export type WebsiteResolution = {
  website: string | null;
  companyName: string;
  city: string | null;
  phone: string | null;
  source: WebsiteSource;
  googleTried: boolean;
};

function acceptWebsite(url: string | null | undefined, companyName: string): string | null {
  if (!url?.trim()) return null;
  const normalized = normalizeWebsite(url);
  if (!normalized) return null;
  return pickOfficialWebsite([normalized], companyName) ?? null;
}

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
    const searchNames = [mapsFacilitySearchName(name), name].filter(
      (v, i, a) => v && a.indexOf(v) === i
    );
    for (const searchName of searchNames) {
      if (Date.now() >= deadline) break;
      const maps = await resolveWebsiteViaMaps(searchName, city, region, {
        deadline,
        maxQueries: 10,
      });
      if (!maps) continue;
      const score = mapsMatchScore(name, maps.name);
      if (score < 0) continue;
      companyName = maps.name;
      if (maps.phone) phone = maps.phone;
      const mapsCity = extractCityFromMapsAddress(maps.address);
      if (mapsCity) resolvedCity = mapsCity;
      if (maps.website && score >= 4) {
        const w = acceptWebsite(maps.website, name);
        if (w) {
          website = w;
          source = "maps-lookup";
          break;
        }
      }
      if (!website && score >= 4 && !maps.website) break;
    }
  }

  if (!website && Date.now() < deadline) {
    googleTried = true;
    const google = await findOfficialWebsite(companyName, resolvedCity, region);
    const w = acceptWebsite(google.website, name);
    if (w) {
      website = w;
      source = "google";
    }
  }

  if (!website && Date.now() < deadline) {
    const guessDeadline = Math.min(deadline, Date.now() + 12_000);
    const guessed = await probeGuessedOfficialWebsite(companyName, { deadline: guessDeadline });
    const w = acceptWebsite(guessed, name);
    if (w) {
      website = w;
      source = "google";
      googleTried = true;
    }
  }

  return { website, companyName, city: resolvedCity, phone, source, googleTried };
}
