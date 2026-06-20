/**
 * E2E discovery Campania — verifica che il contatore salga con scraper fixato.
 * Run: DATABASE_URL=file:... SCAN_ENGINE_LOCAL=1 npx tsx scripts/e2e-discovery-campania.mjs
 */
import { PrismaClient } from "@prisma/client";
import { discoverRegionFromMaps } from "../src/lib/sanita/discover-region.ts";
import { saveRegionDiscoveryState } from "../src/lib/sanita/discovery-state.ts";
import { closeMapsBrowserPool } from "../src/lib/sanita/playwright-maps.ts";
import { isDiscoveryLeadTargetMet } from "../src/lib/sanita/region-min-leads.ts";

const p = new PrismaClient();
const region = "Campania";
const RUN_MS = Number(process.env.E2E_DISCOVERY_MS || 600_000);

const before = await p.lead.count({ where: { type: "HEALTHCARE", region } });
console.log("BEFORE", before, "targetMet", isDiscoveryLeadTargetMet(region, before));

await saveRegionDiscoveryState(region, { mapsCityOffset: 0, mapsDiscoveryComplete: false });

let offset = 0;
const deadline = Date.now() + RUN_MS;
let rounds = 0;

while (Date.now() < deadline) {
  rounds++;
  const d = await discoverRegionFromMaps(region, {
    deadline: Date.now() + 120_000,
    cityOffset: offset,
    includeMinSalute: offset === 0,
  });
  offset = d.mapsCityOffset;
  const after = await p.lead.count({ where: { type: "HEALTHCARE", region } });
  console.log(
    `round ${rounds}: +maps ${d.mapsDiscovered} offset ${d.mapsCityOffset}/${d.citiesTotal} total ${after} complete=${d.discoveryComplete}`
  );
  await saveRegionDiscoveryState(region, {
    mapsCityOffset: d.mapsCityOffset,
    mapsDiscoveryComplete: d.discoveryComplete,
  });
  if (d.discoveryComplete && isDiscoveryLeadTargetMet(region, after)) break;
  if (d.mapsCityOffset >= d.citiesTotal && !isDiscoveryLeadTargetMet(region, after)) {
    console.warn("WARN: offset full but target not met — reset offset for re-pass");
    offset = 0;
    await saveRegionDiscoveryState(region, { mapsCityOffset: 0, mapsDiscoveryComplete: false });
  }
  if (d.mapsDiscovered === 0 && d.mapsCityOffset === offset) {
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const after = await p.lead.count({ where: { type: "HEALTHCARE", region } });
console.log(
  JSON.stringify(
    {
      before,
      after,
      delta: after - before,
      rounds,
      targetMet: isDiscoveryLeadTargetMet(region, after),
      ok: after > before,
    },
    null,
    2
  )
);

await closeMapsBrowserPool().catch(() => {});
await p.$disconnect();
process.exit(after > before ? 0 : 1);
