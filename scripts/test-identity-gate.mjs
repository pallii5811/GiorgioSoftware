import { pickOfficialWebsite } from "../src/lib/sanita/contacts.ts";
import { companyNameOnSite } from "../src/lib/sanita/site-identity.ts";

const santaRitaCorpus =
  "Casa di Cura Santa Rita NefroCenter Atripalda. Amministrazione trasparente. Polizza RC responsabilita civile.";

const villaFeliceCorpus =
  "Centro Medico Residenza Sanitaria Assistenziale Villa Felice S.R.L. San Giorgio del Sannio.";

const cases = [
  { name: "Casa Di Cura S.Rita", host: "https://www.clinicasantarita.eu", corpus: santaRitaCorpus },
  { name: "Villa del Sorriso - Casa di Riposo anziani Avellino", host: "https://www.clinicasantarita.eu", corpus: santaRitaCorpus },
  { name: "Casa Albergo per Anziani Villa Paradiso", host: "https://www.clinicasantarita.eu", corpus: santaRitaCorpus },
  { name: "Centro Geriatrico Padre Pio Srl", host: "https://www.centromedicovillafelice.com", corpus: villaFeliceCorpus },
  {
    name: "Centro Medico Residenza Sanitaria Assistenziale Villa Felice S.R.L.",
    host: "https://www.centromedicovillafelice.com",
    corpus: villaFeliceCorpus,
  },
];

console.log("=== pickOfficialWebsite + companyNameOnSite (simulated crawl) ===\n");
for (const c of cases) {
  const pick = Boolean(pickOfficialWebsite([c.host], c.name));
  const onSite = companyNameOnSite(c.name, c.corpus);
  const pubOk = pick && onSite;
  console.log(c.name.slice(0, 50));
  console.log(`  pickOfficialWebsite: ${pick}`);
  console.log(`  companyNameOnSite:   ${onSite}`);
  console.log(`  => PUBLISHED ok:    ${pubOk}`);
  console.log();
}
