/**
 * Importa gare ANAC + arricchimento contatti per Campania/Veneto (senza server HTTP).
 * Uso: npx tsx scripts/fetch-gare-regions.mjs [Campania] [Veneto]
 */
import { runGareScan } from "../src/lib/gare/engine.ts";

const regions = process.argv.slice(2).filter((r) => ["Campania", "Veneto"].includes(r));
const targets = regions.length ? regions : ["Campania", "Veneto"];

for (const region of targets) {
  console.log(`\n═══ GARE ANAC — ${region} ═══`);
  const result = await runGareScan({ region, commercialOnly: true, max: 200 });
  console.log(result.message);
  console.log(JSON.stringify(result.stats, null, 2));
}

console.log("\n✅ Gare completate\n");
