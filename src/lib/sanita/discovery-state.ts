import fs from "node:fs";
import path from "node:path";
import type { Region } from "@/lib/sanita/discovery";

const STATE_PATH = path.join(process.cwd(), "data", "discovery-state.json");

export type RegionDiscoveryState = {
  mapsCityOffset: number;
  citiesTotal: number;
  mapsDiscoveryComplete: boolean;
  updatedAt: string;
};

type Store = Partial<Record<Region, Omit<RegionDiscoveryState, "citiesTotal">>>;

function readStore(): Store {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as Store;
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(store, null, 2), "utf8");
}

/** Stato discovery Maps persistito sul server (fonte di verità per la UI). */
export async function getRegionDiscoveryState(region: Region): Promise<RegionDiscoveryState> {
  const { getRegionCities } = await import("@/lib/sanita/region-cities");
  const citiesTotal = (await getRegionCities(region)).length;
  const saved = readStore()[region];
  const mapsCityOffset = Math.min(Math.max(0, saved?.mapsCityOffset ?? 0), citiesTotal);
  const mapsDiscoveryComplete = saved?.mapsDiscoveryComplete ?? mapsCityOffset >= citiesTotal;
  return {
    mapsCityOffset,
    citiesTotal,
    mapsDiscoveryComplete: mapsDiscoveryComplete && mapsCityOffset >= citiesTotal,
    updatedAt: saved?.updatedAt ?? "",
  };
}

export async function saveRegionDiscoveryState(
  region: Region,
  patch: { mapsCityOffset: number; mapsDiscoveryComplete: boolean }
): Promise<RegionDiscoveryState> {
  const { getRegionCities } = await import("@/lib/sanita/region-cities");
  const citiesTotal = (await getRegionCities(region)).length;
  const mapsCityOffset = Math.min(Math.max(0, patch.mapsCityOffset), citiesTotal);
  const mapsDiscoveryComplete =
    patch.mapsDiscoveryComplete && mapsCityOffset >= citiesTotal;

  const store = readStore();
  store[region] = {
    mapsCityOffset,
    mapsDiscoveryComplete,
    updatedAt: new Date().toISOString(),
  };
  writeStore(store);

  return { mapsCityOffset, citiesTotal, mapsDiscoveryComplete, updatedAt: store[region]!.updatedAt };
}

export function resetRegionDiscoveryState(region: Region): void {
  const store = readStore();
  delete store[region];
  writeStore(store);
}
