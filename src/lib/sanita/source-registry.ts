/**
 * Registry fonti ufficiali Sanità — Campania / Veneto.
 * Discovery (Maps/Tavily) NON è fonte primaria di esistenza/identità.
 */
export type SanitaSourceKind =
  | "MINISTERO"
  | "REGIONE"
  | "ASL_ULSS"
  | "OPEN_DATA"
  | "ACCREDITAMENTO"
  | "DISCOVERY_ONLY";

export interface SanitaSourceDef {
  id: string;
  name: string;
  region: "CAMPANIA" | "VENETO" | "BOTH";
  kind: SanitaSourceKind;
  url: string;
  /** Se true: può certificare esistenza struttura. */
  primaryOfficial: boolean;
  notes?: string;
}

export const SANITA_SOURCE_REGISTRY: SanitaSourceDef[] = [
  {
    id: "min-salute-strutture",
    name: "Ministero della Salute — anagrafe strutture",
    region: "BOTH",
    kind: "MINISTERO",
    url: "https://www.salute.gov.it/",
    primaryOfficial: true,
    notes: "Dataset/elenchi ministeriali; versione e data da registrare a ogni ingest.",
  },
  {
    id: "campania-regione-sanita",
    name: "Regione Campania — sanità / accreditamento",
    region: "CAMPANIA",
    kind: "REGIONE",
    url: "https://www.regione.campania.it/",
    primaryOfficial: true,
  },
  {
    id: "veneto-regione-sanita",
    name: "Regione Veneto — sanità / ULSS",
    region: "VENETO",
    kind: "REGIONE",
    url: "https://www.regione.veneto.it/",
    primaryOfficial: true,
  },
  {
    id: "asl-campania",
    name: "ASL Campania (Napoli/Caserta/Salerno/Avellino/Benevento)",
    region: "CAMPANIA",
    kind: "ASL_ULSS",
    url: "https://www.aslnapoli1centro.it/",
    primaryOfficial: true,
    notes: "Elenco siti ASL da espandere per provincia; ogni ASL = fonte separata nel ledger.",
  },
  {
    id: "ulss-veneto",
    name: "ULSS Veneto",
    region: "VENETO",
    kind: "ASL_ULSS",
    url: "https://www.aulss3.veneto.it/",
    primaryOfficial: true,
    notes: "Elenco ULSS 1–9 da espandere; ogni ULSS = fonte separata nel ledger.",
  },
  {
    id: "maps-discovery",
    name: "Google Maps (discovery)",
    region: "BOTH",
    kind: "DISCOVERY_ONLY",
    url: "https://maps.google.com/",
    primaryOfficial: false,
    notes: "Mai unica prova di esistenza, identità o applicabilità Gelli.",
  },
  {
    id: "tavily-discovery",
    name: "Tavily search (discovery / WAF fallback)",
    region: "BOTH",
    kind: "DISCOVERY_ONLY",
    url: "https://tavily.com/",
    primaryOfficial: false,
  },
];

export const CAMPANIA_PROVINCES = ["Avellino", "Benevento", "Caserta", "Napoli", "Salerno"] as const;
export const VENETO_PROVINCES = [
  "Belluno",
  "Padova",
  "Rovigo",
  "Treviso",
  "Venezia",
  "Verona",
  "Vicenza",
] as const;
