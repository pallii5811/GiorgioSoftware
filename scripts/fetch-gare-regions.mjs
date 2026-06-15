/**
 * Importa gare ANAC + arricchimento contatti per Campania/Veneto (senza server HTTP).
 * Uso: npx tsx scripts/fetch-gare-regions.mjs [Campania] [Veneto]
 */
import { prisma } from "../src/lib/prisma.ts";
import { fetchAnacAwards } from "../src/lib/gare/anac.ts";
import { enrichTenderBatch } from "../src/lib/gare/enrich.ts";

function isValidCig(cig) {
  return typeof cig === "string" && /^[A-Z0-9]{8,12}$/i.test(cig.trim());
}

function isValidWinner(name) {
  if (typeof name !== "string") return false;
  const n = name.trim();
  if (n.length < 3) return false;
  return !/non\s+specificat|sconosciut|n\/?d|da\s+definire/i.test(n);
}

const regions = process.argv.slice(2).filter((r) => ["Campania", "Veneto"].includes(r));
const targets = regions.length ? regions : ["Campania", "Veneto"];

for (const region of targets) {
  console.log(`\n═══ GARE ANAC — ${region} ═══`);
  const { awards, year, scanned } = await fetchAnacAwards(region, { max: 0 });
  if (year === null) {
    console.log("Dataset ANAC non raggiungibile — riprova più tardi.");
    continue;
  }
  console.log(`Anno ${year} · righe regione: ${scanned} · aggiudicazioni: ${awards.length}`);

  const toEnrich = [];
  let skipped = 0;

  for (const a of awards) {
    if (!isValidCig(a.cig) || !isValidWinner(a.companyName) || !(a.amount > 0)) {
      skipped++;
      continue;
    }
    const cig = a.cig.trim().toUpperCase();
    const lead = await prisma.lead.upsert({
      where: { tenderCig: cig },
      update: {},
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
    toEnrich.push({
      id: lead.id,
      companyName: lead.companyName,
      region,
      meta: {
        year,
        cig,
        object: a.object || "Appalto pubblico",
        buyer: a.buyer,
        amount: a.amount,
      },
    });
  }

  console.log(`In anagrafica: ${toEnrich.length} (scartate: ${skipped})`);
  if (toEnrich.length > 0) {
    const stats = await enrichTenderBatch(toEnrich, 6);
    console.log(`Contatti: ${stats.withPhone} tel, ${stats.withEmail} email / ${stats.enriched} arricchite`);
  }
}

await prisma.$disconnect();
console.log("\n✅ Gare completate\n");
