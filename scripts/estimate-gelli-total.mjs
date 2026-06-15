import { prisma } from "../src/lib/prisma.ts";
import fs from "node:fs";
import { fetchAccreditedClinics } from "../src/lib/sanita/salute.ts";

const comuni = JSON.parse(fs.readFileSync("data/comuni.json", "utf8"));
const comuniC = comuni.Campania?.length ?? 0;
const comuniV = comuni.Veneto?.length ?? 0;

const campania = await fetchAccreditedClinics("Campania");
const veneto = await fetchAccreditedClinics("Veneto");

const total = await prisma.lead.count({ where: { type: "HEALTHCARE" } });
const byRegion = await prisma.lead.groupBy({
  by: ["region"],
  where: { type: "HEALTHCARE" },
  _count: true,
});
const minSalute = await prisma.lead.count({
  where: { type: "HEALTHCARE", osmId: { startsWith: "min-salute/" } },
});
const mapsOnly = total - minSalute;

const citiesInDb = await prisma.lead.groupBy({
  by: ["region", "city"],
  where: { type: "HEALTHCARE", city: { not: null } },
});
const citiesC = new Set(citiesInDb.filter((x) => x.region === "Campania").map((x) => x.city)).size;
const citiesV = new Set(citiesInDb.filter((x) => x.region === "Veneto").map((x) => x.city)).size;

// Proiezione lineare Maps (solo strutture extra vs Min.Salute), con overlap ~30%
const comuniTotal = comuniC + comuniV;
const comuniCoperti = citiesC + citiesV;
const mapsPerComune = comuniCoperti > 0 ? mapsOnly / comuniCoperti : 0;
const mapsProiettati = Math.round(mapsPerComune * comuniTotal * 0.7);
const minSaluteTot = campania.length + veneto.length;
const stimaFinaleBassa = minSaluteTot + mapsProiettati;
const stimaFinaleAlta = Math.round(stimaFinaleBassa * 1.35);

console.log(
  JSON.stringify(
    {
      comuniIstat: { campania: comuniC, veneto: comuniV, totale: comuniTotal },
      minSaluteUfficiale: { campania: campania.length, veneto: veneto.length, totale: minSaluteTot },
      dbAdesso: { totale: total, minSalute, mapsOnly, perRegione: byRegion },
      coperturaScan: {
        comuniConAlmenoUnLead: comuniCoperti,
        percentualeTerritorio: `${((comuniCoperti / comuniTotal) * 100).toFixed(1)}%`,
      },
      stimaTotaleGelliCampaniaVeneto: {
        minimoCerto_minSalute: minSaluteTot,
        stimaProiettataFineScan: `${stimaFinaleBassa} – ${stimaFinaleAlta}`,
        nota: "Case di cura Min.Salute + RSA/poliambulatori/cliniche da Maps su tutti i comuni; esclusi studi singoli e fuori scope",
      },
    },
    null,
    2
  )
);

await prisma.$disconnect();
