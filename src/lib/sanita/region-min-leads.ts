import type { Region } from "@/lib/sanita/discovery";

/** Soglia minima strutture Gelli attese prima di segnare discovery Maps "completata". */
export const REGION_MIN_GELLI_LEADS: Record<Region, number> = {
  Abruzzo: 60,
  Basilicata: 25,
  Calabria: 80,
  Campania: 300,
  "Emilia-Romagna": 180,
  "Friuli-Venezia Giulia": 55,
  Lazio: 220,
  Liguria: 75,
  Lombardia: 300,
  Marche: 70,
  Molise: 15,
  Piemonte: 180,
  Puglia: 160,
  Sardegna: 80,
  Sicilia: 200,
  Toscana: 160,
  "Trentino-Alto Adige": 45,
  Umbria: 45,
  "Valle d'Aosta": 8,
  Veneto: 200,
};

export function discoveryLeadTarget(region: Region): number {
  return REGION_MIN_GELLI_LEADS[region] ?? 200;
}

export function isDiscoveryLeadTargetMet(region: Region, leadCount: number): boolean {
  return leadCount >= discoveryLeadTarget(region);
}
