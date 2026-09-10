import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ITALIAN_REGIONS,
  LEGACY_SCAN_REGIONS,
  REGION_BBOX,
  REGION_ISO,
  isItalianRegion,
} from "../src/lib/sanita/italy-regions.ts";
import { getStoredRegionCities } from "../src/lib/sanita/region-cities.ts";

const comuni = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "data", "comuni.json"), "utf8")
);

assert.equal(ITALIAN_REGIONS.length, 20);
assert.deepEqual(LEGACY_SCAN_REGIONS, ["Campania", "Veneto"]);
assert.deepEqual(Object.keys(comuni).sort(), [...ITALIAN_REGIONS].sort());
assert.deepEqual(Object.keys(REGION_ISO).sort(), [...ITALIAN_REGIONS].sort());
assert.deepEqual(Object.keys(REGION_BBOX).sort(), [...ITALIAN_REGIONS].sort());

let total = 0;
for (const region of ITALIAN_REGIONS) {
  assert.equal(isItalianRegion(region), true);
  const cities = getStoredRegionCities(region);
  assert.ok(cities.length > 0, `${region}: comuni mancanti`);
  assert.equal(cities.length, new Set(cities).size, `${region}: comuni duplicati`);
  total += cities.length;
}
assert.equal(total, 7_894);
assert.ok(comuni.Veneto.includes("Castegnero Nanto"));
assert.ok(!comuni.Veneto.includes("Castegnero"));
assert.ok(!comuni.Veneto.includes("Nanto"));

const runner = fs.readFileSync(
  path.join(process.cwd(), "scripts", "sanita-national-discovery-runner.mjs"),
  "utf8"
);
const jobs = fs.readFileSync(
  path.join(process.cwd(), "src", "lib", "sanita", "national-discovery-jobs.ts"),
  "utf8"
);
const nationalDiscoveryRoute = fs.readFileSync(
  path.join(
    process.cwd(),
    "src",
    "app",
    "api",
    "sanita",
    "national-discovery",
    "route.ts"
  ),
  "utf8"
);
const crawlRuntime = fs.readFileSync(
  path.join(process.cwd(), "src", "lib", "sanita", "lead-crawl-runtime.ts"),
  "utf8"
);
const scanEngine = fs.readFileSync(
  path.join(process.cwd(), "src", "lib", "sanita", "scan-engine.ts"),
  "utf8"
);
const scanStream = fs.readFileSync(
  path.join(process.cwd(), "src", "lib", "sanita", "scan-stream.ts"),
  "utf8"
);
const crawlSlices = fs.readFileSync(
  path.join(process.cwd(), "src", "lib", "sanita", "crawl-slice-runner.ts"),
  "utf8"
);
const mapsDiscovery = fs.readFileSync(
  path.join(process.cwd(), "src", "lib", "sanita", "maps-discovery.ts"),
  "utf8"
);
const regionCities = fs.readFileSync(
  path.join(process.cwd(), "src", "lib", "sanita", "region-cities.ts"),
  "utf8"
);
const playwrightMaps = fs.readFileSync(
  path.join(process.cwd(), "src", "lib", "sanita", "playwright-maps.ts"),
  "utf8"
);
assert.ok(runner.includes("runStreamingScan"));
assert.ok(runner.includes('await import("@/lib/sanita/scan-stream")'));
assert.ok(runner.includes("FRONTIER_DB_PATH"));
assert.ok(runner.includes('join("/var", "lib", "leadsniper", "frontiers")'));
assert.ok(runner.includes("heartbeatTimer"));
assert.ok(runner.includes('process.env.CRAWL_REQUIRE_EXHAUSTIVE_SITE = "1"'));
assert.ok(runner.includes('process.env.CRAWL_RENDER_EVERY_HTML = "1"'));
assert.ok(runner.includes('process.env.CRAWL_HTML_URL_CAP = "0"'));
assert.ok(runner.includes("TERRITORY_SCAN_CONCURRENCY"));
assert.ok(
  /process\.env\.TERRITORY_SCAN_CONCURRENCY\s*\|\|\s*process\.env\.SCAN_STREAM_CONCURRENCY\s*\|\|\s*"[12]"/.test(
    runner
  )
);
assert.ok(runner.includes("TERRITORY_DISCOVERY_MAX_ATTEMPTS"));
assert.ok(runner.includes("await closeMapsBrowserPool().catch"));
assert.ok(runner.includes("existingTerritoryTotal > 0"));
assert.ok(runner.includes("Fonte discovery momentaneamente indisponibile"));
assert.ok(runner.includes("TERRITORY_LEAD_STALL_MS"));
assert.ok(runner.includes('process.env.SCAN_LEAD_STALL_MS || "1200000"'));
assert.ok(runner.includes("readFrontierProgress"));
assert.ok(runner.includes("lastNodeProgressAt"));
assert.ok(runner.includes("n.state <> 'QUEUED'"));
assert.ok(runner.includes("Math.max(...progressTimes)"));
assert.ok(runner.includes("activeProcessingLeadId"));
assert.ok(runner.includes("Il DB della frontiera e la fonte autorevole"));
assert.ok(runner.includes("activeProcessingLeadId = String(row.leadId)"));
assert.ok(runner.includes("progressBelongsToCurrentRunner"));
assert.ok(runner.includes('frontierState: "STARTING"'));
assert.ok(runner.includes("frontierStalled"));
assert.ok(runner.includes("recupero automatico del sito"));
assert.ok(runner.includes('process.env.CRAWL_MAX_SLICES_PER_LEAD = "1"'));
assert.ok(runner.includes("TERRITORY_PLAYWRIGHT_MAX_URLS"));
assert.ok(runner.includes("TERRITORY_PLAYWRIGHT_MAX_MS"));
assert.ok(runner.includes("repairInterruptedTerritoryFrontier"));
assert.ok(runner.includes("INTERRUPTED_FETCH_RESUME"));
assert.ok(runner.includes("resumableEvidence"));
assert.ok(runner.includes("completedButUnresolved"));
assert.ok(runner.includes("isGenuinelyUnattempted"));
assert.ok(runner.includes("interruptedWithoutTimestamp"));
assert.ok(runner.includes("neverAttempted.length === 0"));
assert.ok(runner.includes("lastScannedAt: new Date()"));
assert.ok(runner.includes("retryPriority"));
assert.ok(runner.includes("isAutomaticallyRetryable"));
assert.ok(runner.includes("TERRITORY_RETRY_BATCH"));
assert.ok(runner.includes("TERRITORY_MAX_AUTOMATIC_RETRIES"));
assert.ok(runner.includes('process.env.TERRITORY_MAX_AUTOMATIC_RETRIES || 12'));
assert.ok(runner.includes("automaticRetryLimit"));
assert.ok(runner.includes("requiresFreshWebsiteResolution"));
assert.ok(runner.includes("database or disk is full"));
assert.ok(runner.includes("unresolvedResults"));
assert.ok(runner.includes("selectedForRetry"));
assert.ok(runner.includes("Scansione automatica completata"));
assert.ok(runner.includes('status: "completed"'));
assert.ok(runner.includes("currentTerritoryTotal"));
assert.ok(runner.includes("Risultati progressivi"));
assert.ok(runner.includes("lastScannedAt: null"));
assert.ok(runner.includes("skipDiscovery: true"));
assert.ok(runner.includes("skipDedupe: continuationRound > 1"));
assert.ok(jobs.includes("FRONTIER_DB_PATH"));
assert.ok(jobs.includes("SHADOW_RUN_ID"));
assert.ok(jobs.includes("MAPS_CITY_BUDGET_MS"));
assert.ok(jobs.includes('path.join("/var", "lib", "leadsniper", "frontiers")'));
assert.ok(jobs.includes("cancelNationalDiscoveryJob"));
assert.ok(jobs.includes("sanita-national-discovery-runner.mjs"));
assert.ok(jobs.includes('signalDiscoveryProcess(pid, processGroup, "SIGTERM")'));
assert.ok(jobs.includes('signalDiscoveryProcess(pid, processGroup, "SIGKILL")'));
assert.ok(jobs.includes("Scansione annullata. Checkpoint conservato."));
assert.ok(nationalDiscoveryRoute.includes("await cancelNationalDiscoveryJob(job)"));
assert.ok(mapsDiscovery.includes("TERRITORY_HEALTHCARE_MAP_QUERIES"));
assert.ok(mapsDiscovery.includes("IS_TERRITORY_DISCOVERY ? 120_000 : 55_000"));
assert.ok(regionCities.includes('"centro medico"'));
assert.ok(regionCities.includes('"centro diagnostico"'));
assert.ok(regionCities.includes('"laboratorio analisi cliniche"'));
assert.ok(regionCities.includes('"centro riabilitazione"'));
assert.ok(playwrightMaps.includes("addressMatchesSearchCity"));
assert.ok(!playwrightMaps.includes("function addressMatchesSearchCity(_address"));
assert.ok(crawlRuntime.includes("isTerritorySideCrawl"));
assert.ok(crawlRuntime.includes("NATIONAL_DISCOVERY_JOB_ID"));
assert.ok(crawlRuntime.includes("dirname(prevFrontier!)"));
assert.ok(crawlRuntime.includes("NATIONAL_DISCOVERY_JOB_ID!.replace"));
assert.ok(crawlRuntime.includes("budget?: Partial<CrawlBudgetConfig>"));
assert.ok(crawlRuntime.includes("crawlRunContainsCompletedForeignSite"));
assert.ok(crawlRuntime.includes("hostScopedRunId"));
assert.ok(scanEngine.includes("alternateLookupInconclusive"));
assert.ok(scanEngine.includes("runMaxWallClockMs: 120_000"));
assert.ok(scanEngine.includes("assenza di polizza non certificata"));
assert.ok(scanEngine.includes("if (alternateLookupInconclusive) humanConflict = true"));
assert.ok(scanStream.includes("mapsDiscoveryComplete || skipDiscovery"));
assert.ok(crawlSlices.includes("INTERRUPTED_FETCH_RESUME"));
assert.ok(crawlSlices.includes("htmlUrlCap === 0 ? { urlCapReached: false }"));
assert.ok(runner.includes('active ? "start" : "stop"'));
assert.ok(runner.includes("resumeArchiveEngine"));
assert.ok(runner.includes("Scansione territorio completata"));

console.log("PASS national territory: 20 regioni, 7.894 comuni, pausa/ripresa e scansione integrate");
