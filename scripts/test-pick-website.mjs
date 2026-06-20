import { pickOfficialWebsite } from "../src/lib/sanita/contacts.ts";
const name = "C.D.S. Sas - Centro Diagnostico Sanitario";
console.log("icmspa+CDS:", pickOfficialWebsite(["http://www.icmspa.it"], name));
console.log("cds ok:", pickOfficialWebsite(["https://www.centrodiagnosticosanitario.it"], name));
console.log("pini ok:", pickOfficialWebsite(["https://www.villadeipini.com"], "Villa Dei Pini"));
