import { prisma } from "@/lib/prisma";
import { normalizeWebsite, type Region } from "@/lib/sanita/discovery";
import { discoverFromMaps, mapsOsmId } from "@/lib/sanita/maps-discovery";
import { fetchAccreditedClinics, titleCase } from "@/lib/sanita/salute";
import { isGelliSubjectStructure, isAssistentialOnlyStructure } from "@/lib/sanita/gelli-scope";
import { isDiscoveryLeadTargetMet } from "@/lib/sanita/region-min-leads";
import { pickOfficialWebsite } from "@/lib/sanita/contacts";
import {
  buildLeadIdentityIndex,
  findMatchingLead,
  nameCityKey,
  scanFieldsIfWebsiteHostChanged,
  websiteHostKey,
  type LeadIdentityFields,
} from "@/lib/sanita/lead-dedup";

export type DiscoverRegionResult = {
  mapsDiscovered: number;
  saluteAdded: number;
  mapsCityOffset: number;
  citiesTotal: number;
  discoveryComplete: boolean;
};

function normKey(name: string, city: string | null): string {
  return nameCityKey(name, city);
}

/** Non sovrascrivere un sito già analizzato con un host Maps incoerente col nome struttura. */
function mergeDiscoveryWebsite(
  existing: { website?: string | null; companyName?: string; lastScannedAt?: Date | null } | null | undefined,
  incoming: string | null | undefined,
  companyName: string
): string | null | undefined {
  const inc = incoming ? normalizeWebsite(incoming) : null;
  const kept = existing?.website ? normalizeWebsite(existing.website) : null;
  if (!inc) return kept;
  if (!kept) return pickOfficialWebsite([inc], companyName) ? inc : null;
  const incHost = websiteHostKey(inc);
  const keptHost = websiteHostKey(kept);
  if (existing?.lastScannedAt && incHost && keptHost && incHost !== keptHost) return kept;
  if (pickOfficialWebsite([inc], existing?.companyName ?? companyName)) return inc;
  return kept;
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
      select: {
        id: true,
        companyName: true,
        city: true,
        osmId: true,
        website: true,
        phone: true,
        piva: true,
        region: true,
        lastScannedAt: true,
        createdAt: true,
        leadScore: true,
      },
    });
    const byKey = new Map(existing.map((e) => [normKey(e.companyName, e.city), e]));
    const identityIndex = buildLeadIdentityIndex(existing as LeadIdentityFields[]);

    const registerLead = (lead: (typeof existing)[number]) => {
      byKey.set(normKey(lead.companyName, lead.city), lead);
      for (const key of buildLeadIdentityIndex([lead as LeadIdentityFields]).keys()) {
        identityIndex.set(key, lead as LeadIdentityFields);
      }
    };

    const CHUNK = 40;
    for (let i = 0; i < mapsResult.places.length; i += CHUNK) {
      const slice = mapsResult.places
        .slice(i, i + CHUNK)
        .filter(
          (p) =>
            isGelliSubjectStructure(p.name, p.category) &&
            !isAssistentialOnlyStructure(p.name, p.category)
        );
      // Transazione interattiva: la logica condizionale (update per id, poi
      // fallback upsert per osmId) richiede await — NON è esprimibile come array
      // di PrismaPromise ($transaction([...]) accetta solo promise "pure").
      await prisma.$transaction(async (tx) => {
        for (const p of slice) {
          const key = normKey(p.name, p.city);
          const incomingWebsite = normalizeWebsite(p.website ?? undefined);
          const candidate: LeadIdentityFields = {
            id: "",
            region,
            companyName: p.name,
            city: p.city,
            website: incomingWebsite,
            phone: p.phone ?? null,
            osmId: mapsOsmId(p),
          };
          const dup = byKey.get(key) ?? findMatchingLead(identityIndex, candidate);
          const osmId = mapsOsmId(p);
          const website = mergeDiscoveryWebsite(dup, incomingWebsite, p.name);
          const mergeData = {
            companyName: p.name.length >= (dup?.companyName?.length ?? 0) ? p.name : dup!.companyName,
            city: p.city ?? dup?.city,
            website,
            phone: p.phone ?? dup?.phone,
            category: p.category,
            ...scanFieldsIfWebsiteHostChanged(dup, website),
          };
          // Merge su record esistente solo se ancora in DB (evita P2025 su id stale in indice).
          if (dup?.id) {
            const r = await tx.lead.updateMany({ where: { id: dup.id }, data: mergeData });
            if (r.count > 0) continue;
          }
          const existing = await tx.lead.findUnique({
            where: { osmId },
            select: { website: true, lastScannedAt: true, companyName: true },
          });
          const websiteForOsm = mergeDiscoveryWebsite(existing, incomingWebsite, p.name);
          await tx.lead.upsert({
            where: { osmId },
            update: {
              companyName: p.name,
              region,
              city: p.city,
              website: websiteForOsm,
              phone: p.phone,
              category: p.category,
              ...scanFieldsIfWebsiteHostChanged(existing, websiteForOsm),
            },
            create: {
              type: "HEALTHCARE",
              osmId,
              companyName: p.name,
              region,
              city: p.city,
              website: pickOfficialWebsite([incomingWebsite].filter(Boolean) as string[], p.name)
                ? incomingWebsite
                : null,
              phone: p.phone,
              category: p.category,
              status: "NEW",
            },
          });
        }
      });
      // Ricarica indice dopo ogni chunk (evita id fittizi gmaps/ in update).
      const freshChunk = await prisma.lead.findMany({
        where: { type: "HEALTHCARE", region, osmId: { in: slice.map((p) => mapsOsmId(p)) } },
        select: {
          id: true,
          companyName: true,
          city: true,
          osmId: true,
          website: true,
          phone: true,
          piva: true,
          region: true,
          lastScannedAt: true,
          createdAt: true,
          leadScore: true,
        },
      });
      for (const lead of freshChunk) registerLead(lead);
    }
    // Conteggio solo strutture effettivamente in scope (coerente con UI/progresso)
    mapsDiscovered = mapsResult.places.filter(
      (p) =>
        isGelliSubjectStructure(p.name, p.category) &&
        !isAssistentialOnlyStructure(p.name, p.category)
    ).length;
  }

  const newOffset = cityOffset + mapsResult.citiesScanned.length;
  const leadCount = await prisma.lead.count({ where: { type: "HEALTHCARE", region } });
  const discoveryComplete =
    newOffset >= mapsResult.citiesTotal && isDiscoveryLeadTargetMet(region, leadCount);

  return {
    mapsDiscovered,
    saluteAdded,
    mapsCityOffset: newOffset,
    citiesTotal: mapsResult.citiesTotal,
    discoveryComplete,
  };
}
