import { saveRegionDiscoveryState } from "../src/lib/sanita/discovery-state.ts";

const region = process.argv[2] || "Campania";
await saveRegionDiscoveryState(region, { mapsCityOffset: 0, mapsDiscoveryComplete: false });
console.log(JSON.stringify({ ok: true, region, mapsCityOffset: 0, mapsDiscoveryComplete: false }));
