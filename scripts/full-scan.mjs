/**
 * Scansione completa regione (reset opzionale + loop fino al 100%).
 * Uso: npx tsx scripts/full-scan.mjs Campania [baseUrl] [--reset]
 */
import { Agent, fetch as httpFetch } from "undici";

const region = process.argv[2];
const base = process.argv[3]?.startsWith("http") ? process.argv[3] : "http://localhost:3001";
const reset = process.argv.includes("--reset") || process.argv[3] === "--reset";

// Un round (discovery Maps + analisi esaustiva PDF/OCR) può superare l'ora su siti
// con molti PDF scannerizzati: il timeout client deve sempre superare il round peggiore.
const dispatcher = new Agent({
  headersTimeout: 7_200_000,
  bodyTimeout: 7_200_000,
  connectTimeout: 30_000,
});

if (!region || !["Veneto", "Campania"].includes(region)) {
  console.error("Uso: npx tsx scripts/full-scan.mjs <Veneto|Campania> [baseUrl] [--reset]");
  process.exit(1);
}

async function api(path, opts = {}, attempt = 1) {
  try {
    const res = await httpFetch(`${base}${path}`, {
      ...opts,
      dispatcher,
      headers: { "Content-Type": "application/json", ...opts.headers },
    });
    return { res, json: await res.json().catch(() => null) };
  } catch (e) {
    if (attempt < 4) {
      console.warn(`  (retry ${attempt}/3: ${e.message?.slice(0, 50)})`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
      return api(path, opts, attempt + 1);
    }
    throw e;
  }
}

async function main() {
  console.log(`\n═══ FULL SCAN ${region} @ ${base} ═══\n`);

  if (reset) {
    const { json } = await api(`/api/sanita?region=${encodeURIComponent(region)}`, { method: "DELETE" });
    if (!json?.success) {
      console.error("Reset fallito:", json?.error);
      process.exit(1);
    }
    console.log(`✓ Reset: ${json.removed} lead rimossi\n`);
  }

  let round = 0;
  let payload = { region, forceDiscovery: true };

  while (round < 100) {
    round++;
    process.stdout.write(`Round ${round}… `);
    const { json } = await api("/api/sanita", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (!json?.success) {
      console.error("\nErrore:", json?.error);
      process.exit(1);
    }
    const s = json.stats || {};
    const done = (s.discovered ?? 0) - (s.remainingUnscanned ?? 0);
    console.log(
      `${done}/${s.discovered} | hot=${s.hot} pub=${s.withPolicy} tavily=${s.regionalChecked} rem=${s.remainingUnscanned}`
    );
    if (json.complete || s.remainingUnscanned === 0) {
      console.log(`\n✅ COMPLETATO in ${round} round\n${json.message}\n`);
      const withAudit = (json.data || []).filter((l) => l.evidence?.includes("[FONTI:")).length;
      console.log(`Lead con audit trail: ${withAudit}/${json.data?.length ?? 0}`);
      return;
    }
    payload = {
      region,
      continueAnalysis: true,
      mapsCityOffset: Number(s.mapsCityOffset ?? 0),
    };
  }
  console.error("\n⚠️ Max round raggiunto — rilancia lo script");
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
