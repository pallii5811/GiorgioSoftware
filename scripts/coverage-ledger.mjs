/**
 * Coverage ledger dry-run — Sanità + Gare, Campania + Veneto.
 * Non dichiara completezza. Non modifica DB live.
 *
 * npm run coverage:ledger
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { SANITA_SOURCE_REGISTRY } from "../src/lib/sanita/source-registry.ts";
import { GARE_SOURCE_REGISTRY } from "../src/lib/gare/source-registry.ts";

function emptyLedger(region, engine, sources) {
  return {
    region,
    engine,
    generatedAt: new Date().toISOString(),
    status: "INCOMPLETE",
    completed: false,
    disclaimer:
      "Non è dichiarata copertura completa. Sono contabilizzati solo i record delle fonti/versioni processate.",
    sources: sources.map((s) => ({
      id: s.id,
      name: s.name,
      role: s.role,
      versionOrDate: s.versionOrDate ?? s.asOf ?? null,
      pagesExpected: null,
      pagesProcessed: 0,
      attachmentsExpected: null,
      attachmentsProcessed: 0,
      rawRecords: 0,
      parsedRecords: 0,
      uniqueRecords: 0,
      duplicates: 0,
      exclusions: 0,
      unresolved: 0,
      failures: 0,
      checkpoint: null,
      finalStatus: "NOT_RUN",
    })),
    totals: {
      rawRecords: 0,
      parsedRecords: 0,
      uniqueRecords: 0,
      duplicates: 0,
      exclusions: 0,
      unresolved: 0,
      failures: 0,
    },
    categories: {
      included: [],
      duplicateReconciled: [],
      excludedWithReason: [],
      unresolved: [],
      technicalError: [],
    },
  };
}

mkdirSync("data/coverage/sanita/campania", { recursive: true });
mkdirSync("data/coverage/sanita/veneto", { recursive: true });
mkdirSync("data/coverage/gare/campania", { recursive: true });
mkdirSync("data/coverage/gare/veneto", { recursive: true });

function matchRegion(s, region) {
  const r = (s.region || "").toUpperCase();
  const want = region.toUpperCase();
  return r === "BOTH" || r === "NATIONAL" || r === "IT" || r === want;
}

const outputs = [];
for (const region of ["campania", "veneto"]) {
  const san = emptyLedger(
    region,
    "sanita",
    SANITA_SOURCE_REGISTRY.filter((s) => matchRegion(s, region))
  );
  const path = `data/coverage/sanita/${region}/ledger-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(path, JSON.stringify(san, null, 2));
  outputs.push(path);

  const gar = emptyLedger(
    region,
    "gare",
    GARE_SOURCE_REGISTRY.filter((s) => matchRegion(s, region))
  );
  const gpath = `data/coverage/gare/${region}/ledger-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(gpath, JSON.stringify(gar, null, 2));
  outputs.push(gpath);
}

const overlap = {
  generatedAt: new Date().toISOString(),
  status: "STRUCTURAL_ONLY",
  note: "Populated after real multi-source ingest. No silent drops permitted.",
  multiSource: 0,
  singleSource: 0,
  newFromSource: {},
  provincesUnderrepresented: [],
  categoriesUnderrepresented: [],
  failedSources: [],
  possibleGaps: [
    "ASL/ULSS non ancora ledger individuali",
    "Allegati decreti regionali non ingestiti",
    "Portali regionali gare oltre ANAC non riconciliati",
  ],
};
writeFileSync("data/coverage/source-overlap-stub.json", JSON.stringify(overlap, null, 2));

console.log(JSON.stringify({ ok: true, completed: false, outputs, overlap: "data/coverage/source-overlap-stub.json" }, null, 2));
