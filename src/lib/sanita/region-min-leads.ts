import type { Region } from "@/lib/sanita/discovery";

/** Soglia minima strutture Gelli attese prima di segnare discovery Maps "completata". */
export const REGION_MIN_GELLI_LEADS: Record<Region, number> = {
  Campania: 300,
  Veneto: 200,
};

export function discoveryLeadTarget(region: Region): number {
  return REGION_MIN_GELLI_LEADS[region] ?? 200;
}

export function isDiscoveryLeadTargetMet(region: Region, leadCount: number): boolean {
  return leadCount >= discoveryLeadTarget(region);
}
