import { pickOfficialWebsite } from "../src/lib/sanita/contacts.ts";
import { mapsNamesMatch } from "../src/lib/sanita/maps-query.ts";

const cases = [
  { name: "Casa Di Cura S.Rita", url: "https://www.clinicasantarita.eu", expect: true },
  { name: "Villa del Sorriso - Casa di Riposo anziani Avellino", url: "https://www.clinicasantarita.eu", expect: false },
  { name: "Casa Albergo per Anziani Villa Paradiso", url: "https://www.clinicasantarita.eu", expect: false },
  { name: "Centro Geriatrico Padre Pio Srl", url: "https://www.centromedicovillafelice.com", expect: false },
  {
    name: "Centro Medico Residenza Sanitaria Assistenziale Villa Felice S.R.L.",
    url: "https://www.centromedicovillafelice.com",
    expect: true,
  },
  { name: "C.D.S. Sas - Centro Diagnostico Sanitario", url: "http://www.icmspa.it/", expect: false },
  { name: "C.D.S. Sas - Centro Diagnostico Sanitario", url: "https://www.centrodiagnosticosanitario.it/", expect: true },
  { name: "Villa Dei Pini Casa di Cura Privata S.p.a.", url: "https://www.villadeipini.com/", expect: true },
  { name: "Casa di Riposo Alfonso Rubilli", url: "https://www.casadiriposorubilli.it/", expect: true },
];

const merge = [
  ["Casa Di Cura S.Rita", "Villa del Sorriso - Casa di Riposo anziani Avellino"],
  ["Centro Medico Villa Felice", "Centro Geriatrico Padre Pio Srl"],
];

console.log("=== pickOfficialWebsite ===");
let ok = 0;
for (const c of cases) {
  const got = Boolean(pickOfficialWebsite([c.url], c.name));
  const pass = got === c.expect;
  if (pass) ok++;
  console.log(`${pass ? "OK" : "FAIL"} | ${c.name.slice(0, 40)} | ${c.url} => ${got} (want ${c.expect})`);
}
console.log(`\n${ok}/${cases.length} passed`);

console.log("\n=== mapsNamesMatch (dedup) ===");
for (const [a, b] of merge) {
  console.log(`${mapsNamesMatch(a, b) ? "MERGE" : "SEPARATE"} | "${a}" vs "${b}"`);
}
