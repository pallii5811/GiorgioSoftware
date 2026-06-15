/**
 * RITEST COMPLETO — ogni struttura sanitaria Campania + Veneto.
 * 1) Reset analisi  2) Cerca siti mancanti (Maps/Tavily)  3) Analisi Gelli completa
 *
 * npm run retest:all
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma, ensureSqliteWal } from "../src/lib/sanita/db-ready.ts";
import { bulkEnrichMissingWebsites } from "../src/lib/sanita/website-enrichment.ts";
import { closeMapsBrowserPool } from "../src/lib/sanita/playwright-maps.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const regions = ["Campania", "Veneto"];

if (process.env.OCR_ENABLED === "1") {
  await new Promise((resolve, reject) => {
    const dl = spawn("npx", ["tsx", path.join(dir, "download-tessdata.mjs")], {
      stdio: "inherit",
      shell: true,
    });
    dl.on("exit", (c) => (c === 0 ? resolve() : reject(new Error("tessdata download failed"))));
  });
}

await ensureSqliteWal();
let grandTotal = 0;
let inRegistry = 0;
let toFind = 0;

console.log("\n══════════════════════════════════════════════════════════");
console.log("  RITEST TUTTE LE STRUTTURE — Campania + Veneto");
console.log("══════════════════════════════════════════════════════════\n");

for (const region of regions) {
  const total = await prisma.lead.count({ where: { type: "HEALTHCARE", region } });
  const site = await prisma.lead.count({
    where: { type: "HEALTHCARE", region, website: { not: null }, NOT: { website: "" } },
  });
  const missing = total - site;
  grandTotal += total;
  inRegistry += site;
  toFind += missing;

  await prisma.lead.updateMany({
    where: { type: "HEALTHCARE", region },
    data: { lastScannedAt: null, websiteReachable: null },
  });
  console.log(
    `  ✓ ${region}: ${total} strutture — ${site} sito già in anagrafica, ${missing} da cercare su Maps`
  );
}

console.log(
  `\n  TOTALE: ${grandTotal} strutture (${inRegistry} in anagrafica OSM/Salute, ${toFind} da arricchire)`
);
console.log(`  OCR analisi: ${process.env.OCR_ENABLED === "1" ? "ON" : "OFF"}\n`);

if (toFind > 0 && process.env.SKIP_ENRICH !== "1") {
  console.log("── Fase 1: ricerca siti mancanti (Google Maps + Tavily) ──\n");
  const enrichConc = Number(process.env.ENRICH_CONCURRENCY || 3);
  await bulkEnrichMissingWebsites(regions, {
    concurrency: enrichConc,
    onProgress: (p) => {
      if (p.done % 15 === 0 || p.done === p.total) {
        console.log(`  … ${p.region} ${p.done}/${p.total} (${p.found} siti trovati)`);
      }
    },
  });

  const afterSite = await prisma.lead.count({
    where: {
      type: "HEALTHCARE",
      region: { in: regions },
      website: { not: null },
      NOT: { website: "" },
    },
  });
  console.log(`\n  Dopo arricchimento: ${afterSite}/${grandTotal} con sito\n`);
  await closeMapsBrowserPool().catch(() => {});
}

await prisma.$disconnect();

console.log("── Fase 2: analisi polizza Gelli su ogni struttura ──\n");

const ocr = process.env.OCR_ENABLED === "1" ? "1" : "0";
const child = spawn("npx", ["tsx", path.join(dir, "fast-scan-regions.mjs"), ...regions], {
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    OCR_ENABLED: ocr,
    SCAN_FAST: process.env.SCAN_FAST ?? "1",
    SCAN_CONCURRENCY: process.env.SCAN_CONCURRENCY ?? "6",
  },
});

child.on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  spawn("npx", ["tsx", path.join(dir, "region-status.mjs")], { stdio: "inherit", shell: true });
});
