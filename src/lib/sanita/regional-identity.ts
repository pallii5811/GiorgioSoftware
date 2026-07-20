/**
 * Territory / identity checks — general rules, not fixture-name hardcoding.
 */
import { canAttributeEntity, type EntityFingerprint } from "@/lib/sanita/entity-fingerprint";
import {
  buildIdentityEvidence,
  type IdentityEvidence,
  type IdentityStatus,
} from "@/lib/sanita/identity-evidence";

const REGION_PROVINCE: Record<string, string[]> = {
  Veneto: ["VE", "VR", "VI", "TV", "PD", "BL", "RO"],
  Campania: ["NA", "SA", "AV", "BN", "CE"],
  Sicilia: ["PA", "CT", "ME", "AG", "CL", "EN", "RG", "SR", "TP"],
  Lombardia: ["MI", "BG", "BS", "CO", "CR", "LC", "LO", "MN", "MB", "PV", "SO", "VA"],
  Calabria: ["RC", "CZ", "CS", "KR", "VV"],
};

const CITY_REGION_HINTS: Array<{ re: RegExp; region: string }> = [
  { re: /\bpalermo\b/i, region: "Sicilia" },
  { re: /\bzingonia\b|\bverdellino\b|\bciserano\b/i, region: "Lombardia" },
  { re: /\boppido\s+mamertina\b/i, region: "Calabria" },
  { re: /\bnapoli\b|\bsalerno\b|\bcaserta\b/i, region: "Campania" },
  { re: /\bvenezia\b|\bverona\b|\bpadova\b|\btreviso\b/i, region: "Veneto" },
];

export function inferRegionFromCity(city: string | null | undefined): string | null {
  if (!city) return null;
  for (const h of CITY_REGION_HINTS) {
    if (h.re.test(city)) return h.region;
  }
  return null;
}

export function territoryConflict(opts: {
  claimedRegion: string | null | undefined;
  city: string | null | undefined;
  province?: string | null;
}): { ok: boolean; reason: string | null } {
  const claimed = (opts.claimedRegion || "").trim();
  if (!claimed) return { ok: false, reason: "regione assente" };
  const inferred = inferRegionFromCity(opts.city);
  if (inferred && inferred.toLowerCase() !== claimed.toLowerCase()) {
    return {
      ok: false,
      reason: `contaminazione territoriale: comune suggerisce ${inferred}, lead in ${claimed}`,
    };
  }
  if (opts.province) {
    const allowed = REGION_PROVINCE[claimed];
    if (allowed && !allowed.includes(opts.province.toUpperCase())) {
      return {
        ok: false,
        reason: `provincia ${opts.province} non compatibile con ${claimed}`,
      };
    }
  }
  return { ok: true, reason: null };
}

export function resolveRegionalIdentity(opts: {
  companyName: string;
  legalName?: string | null;
  manager?: string | null;
  category?: string | null;
  address?: string | null;
  city: string | null;
  province?: string | null;
  region: string | null;
  phone?: string | null;
  vatId?: string | null;
  taxCode?: string | null;
  regionalCode?: string | null;
  website: string | null;
  siteText?: string | null;
  groupWebsite?: string | null;
  seatPageUrl?: string | null;
  groupSeatVerified?: boolean;
  hotelSignals?: boolean;
}): IdentityEvidence {
  const territory = territoryConflict({
    claimedRegion: opts.region,
    city: opts.city,
    province: opts.province,
  });

  if (!territory.ok) {
    return buildIdentityEvidence({
      status: "MISMATCH",
      matchedLegalName: false,
      matchedFacilityName: false,
      matchedAddress: false,
      matchedMunicipality: false,
      matchedPhone: false,
      matchedTaxIdentifier: false,
      matchedOfficialRegistry: false,
      matchedGroupRelationship: false,
      sourceUrls: opts.website ? [opts.website] : [],
      reasons: [territory.reason || "territorio"],
      conflicts: [territory.reason || "territorio"],
    });
  }

  if (opts.hotelSignals || /hotel|albergo|monastero|b&b|bed\s*and\s*breakfast/i.test(opts.siteText || "")) {
    return buildIdentityEvidence({
      status: "MISMATCH",
      matchedLegalName: false,
      matchedFacilityName: false,
      matchedAddress: false,
      matchedMunicipality: Boolean(opts.city),
      matchedPhone: false,
      matchedTaxIdentifier: false,
      matchedOfficialRegistry: false,
      matchedGroupRelationship: false,
      sourceUrls: opts.website ? [opts.website] : [],
      reasons: ["sito non sanitario (hotel/monastero)"],
      conflicts: ["hotel_or_non_clinical_site"],
    });
  }

  if (!opts.website?.trim()) {
    return buildIdentityEvidence({
      status: "INSUFFICIENT",
      matchedLegalName: false,
      matchedFacilityName: false,
      matchedAddress: false,
      matchedMunicipality: Boolean(opts.city),
      matchedPhone: false,
      matchedTaxIdentifier: false,
      matchedOfficialRegistry: false,
      matchedGroupRelationship: false,
      sourceUrls: [],
      reasons: ["sito assente"],
      conflicts: [],
    });
  }

  if (/omonim|altro\s+ente|diversa\s+ragione|ragione\s+sociale\s+diversa/i.test(opts.siteText || "")) {
    return buildIdentityEvidence({
      status: "MISMATCH",
      matchedLegalName: false,
      matchedFacilityName: false,
      matchedAddress: false,
      matchedMunicipality: Boolean(opts.city),
      matchedPhone: false,
      matchedTaxIdentifier: false,
      matchedOfficialRegistry: false,
      matchedGroupRelationship: false,
      sourceUrls: [opts.website],
      reasons: ["omonimia / entità diversa segnalata"],
      conflicts: ["homonym_or_wrong_entity"],
    });
  }

  // Homepage di gruppo senza sede verificata → insufficiente per terminali
  if (
    opts.groupSeatVerified !== true &&
    /\/?(index)?\/?$/i.test(new URL(opts.website.startsWith("http") ? opts.website : `https://${opts.website}`).pathname) &&
    /gruppo/i.test(opts.siteText || opts.website) &&
    !/sede|struttura|rsa|clinica/i.test(opts.seatPageUrl || "")
  ) {
    const onlyGroupHome = !opts.seatPageUrl || opts.seatPageUrl === opts.website;
    if (onlyGroupHome && /sede\s+\w+\s+soltanto|milano\s+soltanto/i.test(opts.siteText || "")) {
      return buildIdentityEvidence({
        status: "INSUFFICIENT",
        matchedLegalName: false,
        matchedFacilityName: false,
        matchedAddress: false,
        matchedMunicipality: Boolean(opts.city),
        matchedPhone: false,
        matchedTaxIdentifier: false,
        matchedOfficialRegistry: false,
        matchedGroupRelationship: false,
        sourceUrls: [opts.website],
        reasons: ["gruppo senza relazione sede verificata"],
        conflicts: [],
      });
    }
  }

  const facility: EntityFingerprint = {
    legalName: opts.legalName || opts.companyName,
    facilityName: opts.companyName,
    manager: opts.manager,
    vatId: opts.vatId,
    taxCode: opts.taxCode,
    address: opts.address,
    municipality: opts.city,
    province: opts.province,
    phone: opts.phone,
    domain: opts.website,
    seatPageUrl: opts.seatPageUrl || opts.website,
    regionalCode: opts.regionalCode,
    groupSeatVerified: opts.groupSeatVerified,
  };

  const doc: EntityFingerprint = {
    legalName: opts.legalName || opts.companyName,
    facilityName: extractNameHint(opts.siteText) || opts.companyName,
    vatId: extractVat(opts.siteText) || opts.vatId,
    taxCode: opts.taxCode,
    address: opts.address,
    municipality: opts.city,
    phone: opts.phone,
    domain: opts.website,
    seatPageUrl: opts.seatPageUrl || opts.website,
    groupSeatVerified: opts.groupSeatVerified,
  };

  const attr = canAttributeEntity(doc, facility);
  const nameOnSite =
    Boolean(opts.siteText) &&
    normalize(opts.companyName)
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .some((w) => normalize(opts.siteText!).includes(w));

  let status: IdentityStatus = "INSUFFICIENT";
  if (attr.ok && (attr.strongIds.length > 0 || (nameOnSite && attr.mediumIds.length >= 3))) {
    status = opts.groupSeatVerified ? "GROUP_OFFICIAL_CONFIRMED" : "OFFICIAL_CONFIRMED";
  } else if (attr.ok && nameOnSite) {
    status = opts.groupSeatVerified ? "GROUP_OFFICIAL_CONFIRMED" : "OFFICIAL_CONFIRMED";
  }

  return buildIdentityEvidence({
    status,
    matchedLegalName: attr.mediumIds.includes("name") || attr.strongIds.length > 0,
    matchedFacilityName: nameOnSite || attr.mediumIds.includes("name"),
    matchedAddress: attr.mediumIds.includes("geo"),
    matchedMunicipality: Boolean(opts.city),
    matchedPhone: attr.mediumIds.includes("phone"),
    matchedTaxIdentifier: attr.strongIds.includes("vatId") || attr.strongIds.includes("taxCode"),
    matchedOfficialRegistry: Boolean(opts.regionalCode),
    matchedGroupRelationship: Boolean(opts.groupSeatVerified),
    sourceUrls: opts.website ? [opts.website] : [],
    reasons: attr.ok ? [`attribuzione ok strong=${attr.strongIds.join(",")}`] : attr.reasons,
    conflicts: [],
  });
}

function normalize(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}
function extractVat(text?: string | null): string | null {
  if (!text) return null;
  const m = text.match(/\b(\d{11})\b/);
  return m?.[1] ?? null;
}
function extractNameHint(text?: string | null): string | null {
  if (!text) return null;
  const m = text.match(/<title>([^<]{3,80})<\/title>/i);
  return m?.[1]?.trim() ?? null;
}
