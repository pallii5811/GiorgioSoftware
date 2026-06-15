/**
 * Test territorio completo:
 * 1) Discovery OSM + Min.Salute + Maps (tutte le città)
 * 2) Analisi ogni casa di cura (Campania + Veneto)
 * 3) Import ANAC illimitato + contatti/fonti per ogni gara
 *
 * Uso: npx tsx scripts/full-territory-test.mjs
 */
import { PrismaClient } from "@prisma/client";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const prisma = new PrismaClient();
const dir = path.dirname(fileURLToPath(import.meta.url));
const regions = ["Campania", "Veneto"];
const t0 = Date.now();

function log(msg) {
  const m = ((Date.now() - t0) / 60_000).toFixed(1);
  console.log(`[${m}m] ${msg}`);
}

async function upsertFacilities(region, facilities, normalizeWebsite) {
  if (!facilities.length) return 0;
  const CHUNK = 50;
  for (let i = 0; i < facilities.length; i += CHUNK) {
    const slice = facilities.slice(i, i + CHUNK);
    await prisma.$transaction(
      slice.map((f) =>
        prisma.lead.upsert({
          where: { osmId: f.osmId },
          update: {
            companyName: f.name,
            region,
            category: f.category,
            ...(f.website ? { website: f.website } : {}),
            ...(f.city ? { city: f.city } : {}),
            ...(f.phone ? { phone: f.phone } : {}),
            ...(f.email ? { email: f.email } : {}),
          },
          create: {
            type: "HEALTHCARE",
            osmId: f.osmId,
            companyName: f.name,
            region,
            website: f.website,
            city: f.city,
            phone: f.phone,
            email: f.email,
            category: f.category,
            status: "NEW",
          },
        })
      )
    );
  }
  return facilities.length;
}

async function upsertMapsPlaces(region, places, mapsOsmId, normalizeWebsite) {
  if (!places.length) return 0;
  const CHUNK = 40;
  for (let i = 0; i < places.length; i += CHUNK) {
    const slice = places.slice(i, i + CHUNK);
    await prisma.$transaction(
      slice.map((p) =>
        prisma.lead.upsert({
          where: { osmId: mapsOsmId(p) },
          update: {
            companyName: p.name,
            region,
            city: p.city,
            category: p.category,
            ...(p.website ? { website: normalizeWebsite(p.website) } : {}),
            ...(p.phone ? { phone: p.phone } : {}),
          },
          create: {
            type: "HEALTHCARE",
            osmId: mapsOsmId(p),
            companyName: p.name,
            region,
            city: p.city,
            website: normalizeWebsite(p.website ?? undefined),
            phone: p.phone,
            category: p.category,
            status: "NEW",
          },
        })
      )
    );
  }
  return places.length;
}

async function discoveryRegion(region) {
  const { discoverFacilities, normalizeWebsite } = await import("../src/lib/sanita/discovery.ts");
  const { discoverFromMaps, mapsOsmId } = await import("../src/lib/sanita/maps-discovery.ts");
  const { getRegionCities } = await import("../src/lib/sanita/region-cities.ts");
  const { fetchAccreditedClinics, titleCase } = await import("../src/lib/sanita/salute.ts");

  let osm = 0;
  try {
    const facilities = await discoverFacilities(region);
    osm = await upsertFacilities(region, facilities, normalizeWebsite);
    log(`${region} OSM: ${osm} strutture`);
  } catch (e) {
    log(`${region} OSM skip: ${e.message?.slice(0, 80)}`);
  }

  const clinics = await fetchAccreditedClinics(region);
  let salute = 0;
  if (clinics.length) {
    const existing = await prisma.lead.findMany({
      where: { type: "HEALTHCARE", region },
      select: { companyName: true, city: true },
    });
    const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const keys = new Set(existing.map((e) => `${norm(e.companyName)}|${norm(e.city)}`));
    const ops = [];
    for (const c of clinics) {
      const key = `${norm(c.name)}|${norm(c.city)}`;
      if (keys.has(key)) continue;
      keys.add(key);
      const synthetic = `min-salute/${c.code}`;
      ops.push(
        prisma.lead.upsert({
          where: { osmId: synthetic },
          update: { companyName: titleCase(c.name), city: c.city },
          create: {
            type: "HEALTHCARE",
            osmId: synthetic,
            companyName: titleCase(c.name),
            region,
            city: c.city,
            category: "Casa di cura privata accreditata",
            status: "NEW",
          },
        })
      );
      salute++;
    }
    if (ops.length) {
      for (let i = 0; i < ops.length; i += 50) await prisma.$transaction(ops.slice(i, i + 50));
    }
    log(`${region} Min.Salute: +${salute} nuove`);
  }

  const cities = await getRegionCities(region);
  let offset = 0;
  let mapsTotal = 0;
  while (offset < cities.length) {
    const r = await discoverFromMaps(region, {
      deadline: Date.now() + 3 * 60 * 60_000,
      cityOffset: offset,
      maxCities: 4,
      maxPerCity: 30,
    });
    const n = await upsertMapsPlaces(region, r.places, mapsOsmId, normalizeWebsite);
    mapsTotal += n;
    offset += r.citiesScanned.length;
    log(`${region} Maps ${offset}/${cities.length} città · +${n} (tot ${mapsTotal})`);
    if (r.citiesScanned.length === 0) break;
  }

  const total = await prisma.lead.count({ where: { type: "HEALTHCARE", region } });
  log(`${region} TOTALE in anagrafica: ${total}`);
}

async function importGareRegion(region) {
  const { fetchAnacAwards } = await import("../src/lib/gare/anac.ts");
  const { enrichTenderBatch } = await import("../src/lib/gare/enrich.ts");

  log(`${region} ANAC import illimitato…`);
  const { awards, year, scanned } = await fetchAnacAwards(region, { max: 0 });
  log(`${region} ANAC: ${awards.length} aggiudicazioni (righe regione ${scanned}, anno ${year})`);

  const toEnrich = [];
  let upserted = 0;
  let skipped = 0;

  for (const a of awards) {
    const cig = a.cig.trim().toUpperCase();
    if (!/^[A-Z0-9]{8,12}$/i.test(cig) || !(a.amount > 0)) {
      skipped++;
      continue;
    }
    const lead = await prisma.lead.upsert({
      where: { tenderCig: cig },
      update: {
        companyName: a.companyName.trim(),
        region,
        tenderAmount: a.amount,
        tenderObject: a.object || "Appalto pubblico",
        tenderWinner: a.companyName.trim(),
      },
      create: {
        type: "TENDER",
        companyName: a.companyName.trim(),
        region,
        tenderCig: cig,
        tenderAmount: a.amount,
        tenderObject: a.object || "Appalto pubblico",
        tenderWinner: a.companyName.trim(),
        status: "NEW",
      },
    });
    upserted++;
    if (year !== null) {
      toEnrich.push({
        id: lead.id,
        companyName: lead.companyName,
        region,
        meta: { year, cig, object: a.object, buyer: a.buyer, amount: a.amount },
      });
    }
  }

  log(`${region} gare salvate: ${upserted}, scartate: ${skipped}`);
  if (toEnrich.length) {
    log(`${region} arricchimento contatti ${toEnrich.length} aziende…`);
    const batchSize = 4;
    for (let i = 0; i < toEnrich.length; i += batchSize) {
      const slice = toEnrich.slice(i, i + batchSize);
      const stats = await enrichTenderBatch(slice, 4);
      log(
        `${region} contatti ${Math.min(i + batchSize, toEnrich.length)}/${toEnrich.length} · tel=${stats.withPhone}`
      );
    }
  }
}

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║  TEST TERRITORIO COMPLETO — Campania + Veneto        ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  if (process.env.OCR_ENABLED === undefined) process.env.OCR_ENABLED = "1";

  log("FASE 1 — Discovery territorio");
  for (const region of regions) {
    await discoveryRegion(region);
  }

  log("FASE 2 — Reset analisi + scan ogni struttura");
  for (const region of regions) {
    const n = await prisma.lead.count({ where: { type: "HEALTHCARE", region } });
    await prisma.lead.updateMany({
      where: { type: "HEALTHCARE", region },
      data: { lastScannedAt: null, websiteReachable: null },
    });
    log(`${region}: ${n} strutture in coda analisi`);
  }

  await prisma.$disconnect();

  await new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", path.join(dir, "fast-scan-regions.mjs"), ...regions], {
      stdio: "inherit",
      shell: true,
      env: { ...process.env, SCAN_CONCURRENCY: "4", OCR_ENABLED: "1" },
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`scan exit ${code}`))));
  });

  const prisma2 = new PrismaClient();
  log("FASE 3 — Gare ANAC complete + contatti");
  for (const region of regions) {
    await importGareRegion(region);
  }
  await prisma2.$disconnect();

  log("FASE 4 — Report finale");
  spawn("npx", ["tsx", path.join(dir, "health-report.mjs")], { stdio: "inherit", shell: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
