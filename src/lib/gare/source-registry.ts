/**
 * Registry fonti Gare — ANAC primario; regionali per riconciliazione.
 */
export type GareSourceKind = "ANAC_PRIMARY" | "REGIONAL_PORTAL" | "BUYER_AT" | "DISCOVERY_ONLY";

export interface GareSourceDef {
  id: string;
  name: string;
  region: "CAMPANIA" | "VENETO" | "NATIONAL";
  kind: GareSourceKind;
  url: string;
  primaryOfficial: boolean;
  notes?: string;
}

export const GARE_SOURCE_REGISTRY: GareSourceDef[] = [
  {
    id: "anac-bdncp-ocds",
    name: "ANAC BDNCP / OCDS (data.open-contracting.org)",
    region: "NATIONAL",
    kind: "ANAC_PRIMARY",
    url: "https://dati.anticorruzione.it/",
    primaryOfficial: true,
    notes: "Fonte primaria aggiudicazioni; dataset year ≠ award date.",
  },
  {
    id: "soresa-campania",
    name: "SORESA / e-procurement Campania",
    region: "CAMPANIA",
    kind: "REGIONAL_PORTAL",
    url: "https://www.soresa.it/",
    primaryOfficial: true,
  },
  {
    id: "regione-veneto-gare",
    name: "Portali gare Regione Veneto",
    region: "VENETO",
    kind: "REGIONAL_PORTAL",
    url: "https://www.regione.veneto.it/",
    primaryOfficial: true,
  },
];

/** Finestra minima storica (già in anac/display). */
export const GARE_MIN_AWARD_ISO = "2024-01-01";

export type GareRecencyBucket =
  | "0_30"
  | "31_90"
  | "91_180"
  | "181_365"
  | "ARCHIVE";

export function gareRecencyBucket(awardDate: Date | null): GareRecencyBucket {
  if (!awardDate || Number.isNaN(awardDate.getTime())) return "ARCHIVE";
  const days = Math.floor((Date.now() - awardDate.getTime()) / 86_400_000);
  if (days < 0) return "0_30";
  if (days <= 30) return "0_30";
  if (days <= 90) return "31_90";
  if (days <= 180) return "91_180";
  if (days <= 365) return "181_365";
  return "ARCHIVE";
}
