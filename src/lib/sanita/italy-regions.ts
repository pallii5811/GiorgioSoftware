export const ITALIAN_REGIONS = [
  "Abruzzo",
  "Basilicata",
  "Calabria",
  "Campania",
  "Emilia-Romagna",
  "Friuli-Venezia Giulia",
  "Lazio",
  "Liguria",
  "Lombardia",
  "Marche",
  "Molise",
  "Piemonte",
  "Puglia",
  "Sardegna",
  "Sicilia",
  "Toscana",
  "Trentino-Alto Adige",
  "Umbria",
  "Valle d'Aosta",
  "Veneto",
] as const;

export type ItalianRegion = (typeof ITALIAN_REGIONS)[number];

export const LEGACY_SCAN_REGIONS = ["Campania", "Veneto"] as const satisfies readonly ItalianRegion[];

export function isItalianRegion(value: unknown): value is ItalianRegion {
  return typeof value === "string" && (ITALIAN_REGIONS as readonly string[]).includes(value);
}

export const REGION_ISO: Record<ItalianRegion, string> = {
  Abruzzo: "IT-65",
  Basilicata: "IT-77",
  Calabria: "IT-78",
  Campania: "IT-72",
  "Emilia-Romagna": "IT-45",
  "Friuli-Venezia Giulia": "IT-36",
  Lazio: "IT-62",
  Liguria: "IT-42",
  Lombardia: "IT-25",
  Marche: "IT-57",
  Molise: "IT-67",
  Piemonte: "IT-21",
  Puglia: "IT-75",
  Sardegna: "IT-88",
  Sicilia: "IT-82",
  Toscana: "IT-52",
  "Trentino-Alto Adige": "IT-32",
  Umbria: "IT-55",
  "Valle d'Aosta": "IT-23",
  Veneto: "IT-34",
};

/** [south, west, north, east], usato solo come fallback alla query ISO Overpass. */
export const REGION_BBOX: Record<ItalianRegion, [number, number, number, number]> = {
  Abruzzo: [41.68, 13.02, 42.9, 14.8],
  Basilicata: [39.89, 15.34, 41.14, 16.87],
  Calabria: [37.91, 15.63, 40.15, 17.21],
  Campania: [39.85, 13.75, 41.55, 15.85],
  "Emilia-Romagna": [43.73, 9.2, 45.14, 12.76],
  "Friuli-Venezia Giulia": [45.57, 12.32, 46.65, 13.92],
  Lazio: [40.78, 11.45, 42.84, 14.03],
  Liguria: [43.76, 7.49, 44.68, 10.07],
  Lombardia: [44.68, 8.5, 46.64, 11.43],
  Marche: [42.69, 12.18, 43.97, 13.92],
  Molise: [41.36, 13.94, 42.07, 15.16],
  Piemonte: [44.06, 6.63, 46.46, 9.21],
  Puglia: [39.79, 14.93, 42.23, 18.52],
  Sardegna: [38.85, 8.13, 41.31, 9.83],
  Sicilia: [35.49, 11.91, 38.82, 15.66],
  Toscana: [42.24, 9.68, 44.47, 12.37],
  "Trentino-Alto Adige": [45.67, 10.38, 47.09, 12.48],
  Umbria: [42.36, 11.89, 43.62, 13.27],
  "Valle d'Aosta": [45.46, 6.8, 46.13, 7.94],
  Veneto: [44.75, 10.65, 46.75, 13.15],
};
