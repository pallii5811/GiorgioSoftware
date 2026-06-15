/**
 * Scarica l'elenco COMPLETO dei comuni ISTAT e salva data/comuni.json
 * filtrato per Campania + Veneto (TUTTI i comuni, anche i più piccoli).
 *
 * Uso: npx tsx scripts/download-comuni.mjs
 */
import fs from "node:fs";
import path from "node:path";

const SOURCES = [
  "https://raw.githubusercontent.com/matteocontrini/comuni-json/master/comuni.json",
  "https://cdn.jsdelivr.net/gh/matteocontrini/comuni-json@master/comuni.json",
];

const TARGET_REGIONS = ["Campania", "Veneto"];

async function fetchJson() {
  let lastErr;
  for (const url of SOURCES) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "leadsniper/1.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      console.warn(`  ⚠️ ${url}: ${e.message}`);
    }
  }
  throw lastErr ?? new Error("Nessuna fonte comuni disponibile");
}

async function main() {
  console.log("Scarico elenco comuni ISTAT…");
  const all = await fetchJson();

  const out = {};
  for (const r of TARGET_REGIONS) out[r] = [];

  for (const c of all) {
    const regName = c?.regione?.nome;
    const nome = c?.nome;
    if (!regName || !nome) continue;
    if (TARGET_REGIONS.includes(regName)) out[regName].push(nome);
  }

  for (const r of TARGET_REGIONS) {
    out[r] = [...new Set(out[r])].sort((a, b) => a.localeCompare(b, "it"));
  }

  const dir = path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "comuni.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2), "utf8");

  for (const r of TARGET_REGIONS) console.log(`  ${r}: ${out[r].length} comuni`);
  console.log(`✓ Salvato in ${file}`);
}

main().catch((e) => {
  console.error("Errore download comuni:", e);
  process.exit(1);
});
