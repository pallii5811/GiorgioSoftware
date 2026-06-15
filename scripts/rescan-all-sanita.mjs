/**
 * Rianalisi completa sanità — Campania + Veneto, OCR attivo.
 * Uso: npx tsx scripts/rescan-all-sanita.mjs
 */
import { PrismaClient } from "@prisma/client";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.OCR_ENABLED = "1";

const dir = path.dirname(fileURLToPath(import.meta.url));

await new Promise((resolve, reject) => {
  const dl = spawn("npx", ["tsx", path.join(dir, "download-tessdata.mjs")], {
    stdio: "inherit",
    shell: true,
  });
  dl.on("exit", (c) => (c === 0 ? resolve() : reject(new Error("tessdata download failed"))));
});

const prisma = new PrismaClient();
const regions = ["Campania", "Veneto"];

console.log("\n⚡ RESCAN COMPLETO — OCR attivo — Campania + Veneto\n");

for (const region of regions) {
  const total = await prisma.lead.count({ where: { type: "HEALTHCARE", region } });
  const withSite = await prisma.lead.count({
    where: { type: "HEALTHCARE", region, website: { not: null } },
  });
  await prisma.lead.updateMany({
    where: { type: "HEALTHCARE", region },
    data: { lastScannedAt: null, websiteReachable: null },
  });
  console.log(`✓ ${region}: ${total} strutture (${withSite} con sito) in coda`);
}

await prisma.$disconnect();

const child = spawn("npx", ["tsx", path.join(dir, "fast-scan-regions.mjs"), ...regions], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, OCR_ENABLED: "1", SCAN_FAST: "1", SCAN_CONCURRENCY: "8" },
});

child.on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  spawn("npx", ["tsx", path.join(dir, "policy-stats.mjs")], { stdio: "inherit", shell: true });
});
