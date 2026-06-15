/**
 * Scansione veloce — motore diretto, parallelo, senza budget SSE da 4 min.
 * Uso: npx tsx scripts/fast-scan-regions.mjs [Campania] [Veneto]
 * Env: SCAN_CONCURRENCY / SCAN_ANALYSIS_CONCURRENCY, OCR_ENABLED=1, POLICY_EXHAUSTIVE=1
 */
// Garanzia accuratezza: crawl esaustivo + OCR sempre attivi (non disabilitare per velocità).
process.env.OCR_ENABLED = process.env.OCR_ENABLED ?? "1";
process.env.POLICY_EXHAUSTIVE = process.env.POLICY_EXHAUSTIVE ?? "1";

import { SCAN_ANALYSIS_CONCURRENCY } from "../src/lib/sanita/scan-config.ts";

const CONCURRENCY = Number(
  process.env.SCAN_CONCURRENCY || process.env.SCAN_ANALYSIS_CONCURRENCY || SCAN_ANALYSIS_CONCURRENCY
);
const cliRegions = process.argv.slice(2).filter((a) => ["Campania", "Veneto"].includes(a));
const regions = cliRegions.length ? cliRegions : ["Campania", "Veneto"];

async function main() {
  const { installOcrSafetyHandlers } = await import("../src/lib/sanita/ocr.ts");
  installOcrSafetyHandlers();

  // UN SOLO PrismaClient (con WAL) — niente secondo pool che causa lock/timeout P1008.
  const { prisma, ensureSqliteWal } = await import("../src/lib/sanita/db-ready.ts");
  await ensureSqliteWal();

  const { completeLeadAnalysis, runBatch } = await import("../src/lib/sanita/scan-engine.ts");
  const { closeMapsBrowserPool } = await import("../src/lib/sanita/playwright-maps.ts");
  const { terminateOcrWorker } = await import("../src/lib/sanita/ocr.ts");

  const tStart = Date.now();

  console.log(`\n⚡ FAST SCAN — ${regions.join(" + ")} (×${CONCURRENCY} parallelo)\n`);

  for (const region of regions) {
    const total = await prisma.lead.count({ where: { type: "HEALTHCARE", region } });
    let round = 0;

    console.log(`═══ ${region}: ${total} strutture ═══`);

    while (true) {
      const batch = await prisma.lead.findMany({
        where: { type: "HEALTHCARE", region, lastScannedAt: null },
        orderBy: [{ website: "desc" }, { createdAt: "asc" }],
        take: CONCURRENCY,
      });
      if (batch.length === 0) break;

      round++;
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
        } catch (e) {
          console.warn(`  ⚠️ ${lead.companyName?.slice(0, 40)}: ${e.message?.slice(0, 60)}`);
          await prisma.lead.update({
            where: { id: lead.id },
            data: {
              lastScannedAt: new Date(),
              evidence: `[V:REVIEW] Errore analisi: ${e.message?.slice(0, 120) ?? "sconosciuto"}`,
            },
          });
        }
      });

      const remaining = await prisma.lead.count({
        where: { type: "HEALTHCARE", region, lastScannedAt: null },
      });
      const done = total - remaining;
      const sec = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(
        `  [${done}/${total}] batch ${round} in ${sec}s | hot+${counters.hot} pub+${counters.withPolicy} | rem=${remaining}`
      );
    }

    console.log(`✅ ${region} completata\n`);
  }

  await terminateOcrWorker().catch(() => {});
  await closeMapsBrowserPool().catch(() => {});
  await prisma.$disconnect();

  const mins = ((Date.now() - tStart) / 60_000).toFixed(1);
  console.log(`\n🏁 Finito in ${mins} minuti\n`);

  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  spawn("npx", ["tsx", join(dirname(fileURLToPath(import.meta.url)), "region-status.mjs")], {
    stdio: "inherit",
    shell: true,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
