/**
 * Test lookup Google Maps (port MIRAX) — richiede rete + Playwright Chromium.
 * Uso: npx tsx scripts/test-maps.mjs
 */
import { lookupBusinessOnMaps } from "../src/lib/sanita/playwright-maps.ts";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const pinetaDb = await prisma.lead.findFirst({
  where: { companyName: { contains: "Pineta Grande" } },
  select: { companyName: true, city: true },
});
const santaDb = await prisma.lead.findFirst({
  where: { companyName: { contains: "Santa Patrizia" } },
  select: { companyName: true, city: true },
});

const CASES = [
  {
    name: pinetaDb?.companyName ?? "Casa Di Cura Pineta Grande",
    city: pinetaDb?.city ?? "Castel Volturno",
    region: "Campania",
    expectWebsite: "pinetagrande.it",
    label: "Pineta (nome DB)",
  },
  {
    name: "Casa Di Cura Pineta Grande",
    city: "Castel Volturno",
    region: "Campania",
    expectWebsite: "pinetagrande.it",
    label: "Pineta (canonical)",
  },
  {
    name: santaDb?.companyName ?? "Clinica Santa Patrizia",
    city: santaDb?.city ?? "Napoli",
    region: "Campania",
    expectWebsite: "casadicurasantapatrizia.it",
    label: "Santa Patrizia",
  },
];

let failed = 0;

for (const c of CASES) {
  console.log(`\n→ Maps lookup: "${c.name}" (${c.city})…`);
  const t0 = Date.now();
  try {
    const hit = await lookupBusinessOnMaps(c.name, c.city, c.region);
    const ms = Date.now() - t0;
    if (!hit) {
      console.error(`  ✗ Nessun risultato (${ms}ms)`);
      failed++;
      continue;
    }
    const site = hit.website || "(nessun sito)";
    const ok = hit.website?.includes(c.expectWebsite);
    console.log(`  name: ${hit.name}`);
    console.log(`  website: ${site}`);
    console.log(`  phone: ${hit.phone || "—"}`);
    console.log(`  ${ok ? "✓" : "✗"} atteso: ${c.expectWebsite} (${ms}ms)`);
    if (!ok) failed++;
  } catch (e) {
    console.error(`  ✗ Errore: ${e.message}`);
    failed++;
  }
}

await prisma.$disconnect();
console.log(failed ? `\n❌ ${failed} test Maps falliti` : "\n✅ Tutti i test Maps OK");
process.exit(failed ? 1 : 0);
