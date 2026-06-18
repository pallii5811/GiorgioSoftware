/**
 * Produzione Hetzner — stesso flusso della UI:
 *   1) scopre strutture (Maps, a blocchi)
 *   2) analizza SUBITO ogni lead in coda (×N parallelo)
 *   3) ripete fino a regione completa
 */
process.env.NODE_ENV = "production";
process.env.OCR_ENABLED = "1";
process.env.POLICY_EXHAUSTIVE = "1";
process.env.SCAN_FAST = "0";

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { installOcrSafetyHandlers } from "../src/lib/sanita/ocr.ts";
import { discoverRegionFromMaps } from "../src/lib/sanita/discover-region.ts";
import { saveRegionDiscoveryState, getRegionDiscoveryState } from "../src/lib/sanita/discovery-state.ts";
import { closeMapsBrowserPool } from "../src/lib/sanita/playwright-maps.ts";
import { ensureSqliteWal, prisma } from "../src/lib/sanita/db-ready.ts";
import { terminateOcrWorker } from "../src/lib/sanita/ocr.ts";
import { completeLeadAnalysis, runBatch } from "../src/lib/sanita/scan-engine.ts";
import { SCAN_ANALYSIS_CONCURRENCY } from "../src/lib/sanita/scan-config.ts";

/** Minuti di Maps per round prima di passare all'analisi (come la UI, non 45 min tutto discovery). */
const DISCOVERY_CHUNK_MS = Number(process.env.DISCOVERY_CHUNK_MS || 12 * 60_000);
const CONCURRENCY = Number(
  process.env.SCAN_CONCURRENCY || process.env.SCAN_ANALYSIS_CONCURRENCY || SCAN_ANALYSIS_CONCURRENCY
);
const cli = process.argv.slice(2).filter((r) => ["Campania", "Veneto"].includes(r));
const regions = cli.length ? cli : ["Campania", "Veneto"];

function runScript(name, args = []) {
  const dir = dirname(fileURLToPath(import.meta.url));
  return new Promise((resolve, reject) => {
    const p = spawn("npx", ["tsx", join(dir, name), ...args], { stdio: "inherit", shell: true });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${name} exit ${code}`))));
  });
}

async function analyzePending(region) {
  let batchNum = 0;
  while (true) {
    const batch = await prisma.lead.findMany({
      where: { type: "HEALTHCARE", region, lastScannedAt: null },
      orderBy: [{ website: "desc" }, { createdAt: "asc" }],
      take: CONCURRENCY,
    });
    if (batch.length === 0) break;

    batchNum++;
    const counters = {
      analyzed: 0,
      withPolicy: 0,
      hot: 0,
      review: 0,
      regionalChecked: 0,
      regionalWithPolicy: 0,
    };
    const t0 = Date.now();

    await runBatch(batch, CONCURRENCY, async (lead) => {
      try {
        await completeLeadAnalysis(lead, region, counters);
        const v = (await prisma.lead.findUnique({ where: { id: lead.id }, select: { evidence: true } }))
          ?.evidence;
        console.log(`    ✓ ${lead.companyName?.slice(0, 45)} → ${v?.slice(0, 30) ?? "?"}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`    ⚠️ ${lead.companyName?.slice(0, 40)}: ${msg.slice(0, 60)}`);
        await prisma.lead.update({
          where: { id: lead.id },
          data: {
            lastScannedAt: new Date(),
            evidence: `[V:REVIEW] Errore analisi: ${msg.slice(0, 120)}`,
          },
        });
      }
    });

    const total = await prisma.lead.count({ where: { type: "HEALTHCARE", region } });
    const remaining = await prisma.lead.count({
      where: { type: "HEALTHCARE", region, lastScannedAt: null },
    });
    const sec = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(
      `  analisi batch ${batchNum} in ${sec}s | [${total - remaining}/${total}] | ` +
        `hot+${counters.hot} pub+${counters.withPolicy}`
    );
  }
}

async function processRegion(region) {
  const saved = await getRegionDiscoveryState(region);
  let offset = saved.mapsCityOffset;
  let round = 0;
  let discoveryComplete = saved.mapsDiscoveryComplete;

  console.log(`\n═══ ${region} (discover → analizza → ripeti) ═══`);
  console.log(`  Comuni Maps: ${offset}/${saved.citiesTotal}\n`);

  while (true) {
    round++;

    if (!discoveryComplete) {
      const deadline = Date.now() + DISCOVERY_CHUNK_MS;
      const r = await discoverRegionFromMaps(region, {
        deadline,
        cityOffset: offset,
        includeMinSalute: round === 1 && offset === 0,
      });
      offset = r.mapsCityOffset;
      discoveryComplete = r.discoveryComplete;
      await saveRegionDiscoveryState(region, {
        mapsCityOffset: offset,
        mapsDiscoveryComplete: discoveryComplete,
      });
      await closeMapsBrowserPool().catch(() => {});

      const total = await prisma.lead.count({ where: { type: "HEALTHCARE", region } });
      console.log(
        `  [round ${round}] Maps +${r.mapsDiscovered} Min.Salute +${r.saluteAdded} | ` +
          `città ${r.mapsCityOffset}/${r.citiesTotal} | DB=${total} | maps_done=${discoveryComplete}`
      );
    }

    const pendingBefore = await prisma.lead.count({
      where: { type: "HEALTHCARE", region, lastScannedAt: null },
    });
    if (pendingBefore > 0) {
      console.log(`  → Analisi ${pendingBefore} in coda (×${CONCURRENCY})…`);
      await analyzePending(region);
    }

    const pending = await prisma.lead.count({
      where: { type: "HEALTHCARE", region, lastScannedAt: null },
    });
    const total = await prisma.lead.count({ where: { type: "HEALTHCARE", region } });
    const done = total - pending;
    console.log(`  [round ${round} fine] ${done}/${total} analizzati | pending=${pending}\n`);

    if (discoveryComplete && pending === 0) break;
  }

  console.log(`✅ ${region} completata\n`);
}

async function main() {
  installOcrSafetyHandlers();
  await ensureSqliteWal();

  for (const region of regions) {
    await processRegion(region);
  }

  await terminateOcrWorker().catch(() => {});
  await closeMapsBrowserPool().catch(() => {});

  console.log("\n═══ CERTIFICAZIONE ═══\n");
  try {
    await runScript("quality-gate.mjs");
  } catch {
    console.warn("quality-gate: fix in corso…");
  }
  try {
    await runScript("fix-delivery-blockers.mjs");
  } catch {
    /* optional */
  }
  await runScript("delivery-certification.mjs");
  await runScript("region-status.mjs");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await terminateOcrWorker().catch(() => {});
    await closeMapsBrowserPool().catch(() => {});
    await prisma.$disconnect();
  });
