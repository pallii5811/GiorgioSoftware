import { prisma } from "@/lib/prisma";
import { normalizeWebsite, type Region } from "@/lib/sanita/discovery";
import { discoverFromMaps, mapsOsmId } from "@/lib/sanita/maps-discovery";
import { fetchAccreditedClinics, titleCase } from "@/lib/sanita/salute";

export type DiscoverRegionResult = {
  mapsDiscovered: number;
  saluteAdded: number;
  mapsCityOffset: number;
  citiesTotal: number;
  discoveryComplete: boolean;
};

function normKey(name: string, city: string | null): string {
  const n = (name || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const c = (city || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return `${n}|${c}`;
}

/** Case di cura accreditate Min. Salute — nome/comune senza URL (sito si trova via Maps/Google in analisi). */
async function upsertMinSaluteClinics(region: Region): Promise<number> {
  const clinics = await fetchAccreditedClinics(region);
  if (clinics.length === 0) return 0;

  const existing = await prisma.lead.findMany({
    where: { type: "HEALTHCARE", region },
    select: { companyName: true, city: true },
  });
  const keys = new Set(existing.map((e) => normKey(e.companyName, e.city)));

  let added = 0;
  const ops = [];
  for (const c of clinics) {
    const companyName = titleCase(c.name);
    const key = normKey(companyName, c.city);
    if (keys.has(key)) continue;
    keys.add(key);
    const synthetic = `min-salute/${c.code}`;
    ops.push(
      prisma.lead.upsert({
        where: { osmId: synthetic },
        update: {
          companyName,
          city: c.city,
          category: "Casa di cura accreditata (Min. Salute)",
        },
        create: {
          type: "HEALTHCARE",
          osmId: synthetic,
          companyName,
          region,
          city: c.city,
          website: null,
          category: "Casa di cura accreditata (Min. Salute)",
          status: "NEW",
        },
      })
    );
    added++;
  }

  if (ops.length > 0) {
    const CHUNK = 50;
    for (let i = 0; i < ops.length; i += CHUNK) {
      await prisma.$transaction(ops.slice(i, i + CHUNK));
    }
  }
  return added;
}

/**
 * Scoperta strutture sul web:
 * - Google Maps (nome, città, sito dalla scheda)
 * - Min. Salute accreditate (sito risolto in analisi via Maps + Google)
 * Nessun OSM — nessun match anagrafiche esterne.
 */
export async function discoverRegionFromMaps(
  region: Region,
  opts: { deadline: number; cityOffset?: number; includeMinSalute?: boolean }
): Promise<DiscoverRegionResult> {
  const cityOffset = opts.cityOffset ?? 0;
  let saluteAdded = 0;

  if ((opts.includeMinSalute ?? cityOffset === 0) && Date.now() < opts.deadline) {
    saluteAdded = await upsertMinSaluteClinics(region);
  }

  const mapsResult = await discoverFromMaps(region, {
    deadline: opts.deadline,
    cityOffset,
    maxPerCity: 50,
    maxCities: 999,
  });

  let mapsDiscovered = 0;
  if (mapsResult.places.length > 0) {
    const existing = await prisma.lead.findMany({
      where: { type: "HEALTHCARE", region },
      select: { id: true, companyName: true, city: true, osmId: true, website: true, phone: true },
    });
    const byKey = new Map(existing.map((e) => [normKey(e.companyName, e.city), e]));

    const CHUNK = 40;
    for (let i = 0; i < mapsResult.places.length; i += CHUNK) {
      const slice = mapsResult.places.slice(i, i + CHUNK);
      await prisma.$transaction(
        slice.map((p) => {
          const key = normKey(p.name, p.city);
          const dup = byKey.get(key);
          const website = normalizeWebsite(p.website ?? undefined);
          if (dup) {
            return prisma.lead.update({
              where: { id: dup.id },
              data: {
                companyName: p.name,
                city: p.city,
                website: website ?? dup.website,
                phone: p.phone ?? dup.phone,
                category: p.category,
              },
            });
          }
          const osmId = mapsOsmId(p);
          byKey.set(key, {
            id: osmId,
            companyName: p.name,
            city: p.city,
            osmId,
            website: website ?? null,
            phone: p.phone ?? null,
          });
          return prisma.lead.upsert({
            where: { osmId },
            update: {
              companyName: p.name,
              region,
              city: p.city,
              website,
              phone: p.phone,
              category: p.category,
            },
            create: {
              type: "HEALTHCARE",
              osmId,
              companyName: p.name,
              region,
              city: p.city,
              website,
              phone: p.phone,
              category: p.category,
              status: "NEW",
            },
          });
        })
      );
    }
    mapsDiscovered = mapsResult.places.length;
  }

  const newOffset = cityOffset + mapsResult.citiesScanned.length;
  const discoveryComplete =
    mapsResult.citiesScanned.length === 0 || newOffset >= mapsResult.citiesTotal;

  return {
    mapsDiscovered,
    saluteAdded,
    mapsCityOffset: newOffset,
    citiesTotal: mapsResult.citiesTotal,
    discoveryComplete,
  };
}
