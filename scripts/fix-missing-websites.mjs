/**
 * Riesegue analisi per strutture senza sito (es. Min. Salute) con ricerca Tavily migliorata.
 * Uso: npx tsx scripts/fix-missing-websites.mjs Campania [baseUrl]
 */
import { Agent, fetch as httpFetch } from "undici";

const region = process.argv[2] || "Campania";
const base = process.argv[3]?.startsWith("http") ? process.argv[3] : "http://localhost:3001";
const dispatcher = new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 });

async function post(body) {
  const res = await httpFetch(`${base}/api/sanita`, {
    method: "POST",
    dispatcher,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function main() {
  console.log(`\nRicerca siti mancanti — ${region}\n`);
  let round = 0;
  let payload = { region, fixMissingWebsites: true, continueAnalysis: true };

  while (round < 50) {
    round++;
    const json = await post(payload);
    if (!json.success) {
      console.error(json.error);
      process.exit(1);
    }
    const s = json.stats || {};
    const noSite = (json.data || []).filter((l) => l.region === region && !l.website).length;
    const withSite = (json.data || []).filter((l) => l.region === region && l.website).length;
    console.log(
      `Round ${round}: rem=${s.remainingUnscanned} | ${region} con sito=${withSite} senza sito=${noSite}`
    );
    if (json.complete || s.remainingUnscanned === 0) {
      console.log("\n✓ Completato\n");
      return;
    }
    payload = { region, continueAnalysis: true };
  }
}

main().catch(console.error);
