import { resolveOfficialWebsite } from "../src/lib/sanita/resolve-website.ts";
import { closeMapsBrowserPool } from "../src/lib/sanita/playwright-maps.ts";

const cases = [
  ["Ios - Ex Casa Di Cura 'Meluccio' S.r.l.", "Pomigliano d'Arco", "Campania"],
  ["Casa Di Cura 'Clinica S.Antimo'", "San Felice a Cancello", "Campania"],
  ["Presidio Ospedaliero di San Felice a Cancello - Asl Caserta", "San Felice a Cancello", "Campania"],
  ["Centro Medico Leonardo Bianchi", "San Bartolomeo in Galdo", "Campania"],
];

for (const [name, city, region] of cases) {
  const r = await resolveOfficialWebsite(name, city, region, {
    deadline: Date.now() + 120_000,
  });
  console.log(JSON.stringify({ name, website: r.website, source: r.source }, null, 2));
}

await closeMapsBrowserPool().catch(() => {});
