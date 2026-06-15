/**
 * Test completo Campania + Veneto — rianalizza ogni struttura con il motore aggiornato.
 * Uso: npx tsx scripts/full-test-regions.mjs [baseUrl] [--no-reset]
 */
import { Agent, fetch as httpFetch } from "undici";
import { PrismaClient } from "@prisma/client";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const base = process.argv.find((a) => a.startsWith("http")) || "http://localhost:3001";
const skipReset = process.argv.includes("--no-reset");
const regions = ["Campania", "Veneto"];

const dispatcher = new Agent({
  headersTimeout: 600_000,
  bodyTimeout: 600_000,
  connectTimeout: 30_000,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function streamScan(region, payload, attempt = 1) {
  try {
    return await streamScanOnce(region, payload);
  } catch (e) {
    if (attempt < 5) {
      const wait = 15_000 * attempt;
      console.warn(`\n  ⚠️ Errore sessione (tentativo ${attempt}/4): ${e.message?.slice(0, 80)}`);
      console.warn(`  → nuovo tentativo tra ${wait / 1000}s…`);
      await sleep(wait);
      return streamScan(region, payload, attempt + 1);
    }
    throw e;
  }
}

async function streamScanOnce(region, payload) {
  const res = await httpFetch(`${base}/api/sanita/stream`, {
    method: "POST",
    dispatcher,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok || !res.body) throw new Error(`Stream HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let stats = {};
  let leads = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const chunks = buf.split("\n\n");
    buf = chunks.pop() ?? "";
    for (const chunk of chunks) {
      let event = "message";
      let dataLine = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data: ")) dataLine = line.slice(6);
      }
      if (!dataLine) continue;
      const data = JSON.parse(dataLine);
      if (event === "progress") {
        process.stdout.write(
          `\r  ${region}: ${data.done ?? 0}/${data.total ?? "?"} — ${String(data.message ?? "").slice(0, 70).padEnd(70)}`
        );
      }
      if (event === "lead") leads++;
      if (event === "paused" || event === "complete") stats = data.stats ?? stats;
      if (event === "error") throw new Error(data.message || "stream error");
    }
  }

  console.log(`\n  Sessione ${region}: +${leads} lead emessi | rem=${stats.remainingUnscanned ?? "?"}`);
  return { stats, complete: stats.complete === true || stats.remainingUnscanned === 0 };
}

async function main() {
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║  FULL TEST — Campania + Veneto (ogni struttura)  ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  const prisma = new PrismaClient();

  for (const region of regions) {
    const total = await prisma.lead.count({ where: { type: "HEALTHCARE", region } });
    if (!skipReset && total > 0) {
      await prisma.lead.updateMany({
        where: { type: "HEALTHCARE", region },
        data: { lastScannedAt: null, websiteReachable: null },
      });
      console.log(`✓ ${region}: ${total} strutture in coda per rianalisi completa`);
    } else {
      console.log(`→ ${region}: ${total} strutture (senza reset)`);
    }
  }
  await prisma.$disconnect();

  for (const region of regions) {
    console.log(`\n═══ STREAM SCAN ${region} ═══`);
    let round = 0;
    // Strutture già in DB: salta discovery (Maps/OSM) e usa tutto il budget per l'analisi.
    let payload = { region, continueAnalysis: true, fixMissingWebsites: true };
    let done = false;

    const maxRounds = 250;
    while (!done && round < maxRounds) {
      round++;
      const ts = new Date().toISOString().slice(11, 19);
      console.log(`\n[${ts}] Sessione ${round}…`);
      const result = await streamScan(region, payload);
      done = result.complete;
      if (!done) {
        payload = {
          region,
          continueAnalysis: true,
          fixMissingWebsites: round % 10 === 0,
          mapsCityOffset: Number(result.stats.mapsCityOffset ?? 0),
        };
      }
    }

    if (!done) {
      console.error(`\n⚠️ ${region}: max sessioni (${maxRounds}) — rilancia: npm run scan:all`);
      process.exitCode = 2;
    } else {
      console.log(`\n✅ ${region} COMPLETATA\n`);
    }
  }

  console.log("\n── Report finale ──");
  const dir = path.dirname(fileURLToPath(import.meta.url));
  spawn("npx", ["tsx", path.join(dir, "region-status.mjs")], {
    stdio: "inherit",
    shell: true,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
