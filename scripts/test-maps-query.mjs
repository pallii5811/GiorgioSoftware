import {
  mapsNameVariants,
  mapsNamesMatch,
  mapsSearchQueries,
  mapsMatchScore,
  mapsPrimaryName,
} from "../src/lib/sanita/maps-query.ts";
import { pickOfficialWebsite } from "../src/lib/sanita/contacts.ts";
import { extractCityFromMapsAddress } from "../src/lib/sanita/maps-query.ts";
import { isBlockedWebsiteHost, normalizeOfficialWebsite } from "../src/lib/sanita/website.ts";

let failed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error("✗", msg);
    failed++;
  } else console.log("✓", msg);
}

const pineta = "Pineta Grande S.p.A. - Cdic Villa Esther";
ok(mapsNameVariants(pineta).some((v) => v.includes("Villa Esther")), "varianti includono Villa Esther");
ok(mapsNameVariants(pineta).some((v) => v.includes("Pineta Grande")), "varianti includono Pineta Grande");
ok(mapsNamesMatch(pineta, "Pineta Grande Hospital"), "match Pineta Hospital");
ok(mapsNamesMatch("Clinica Santa Patrizia", "Casa di Cura S.Patrizia"), "match Santa Patrizia");
ok(mapsSearchQueries(pineta, "Avellino", "Campania").length >= 3, "query multiple con fallback regione");
ok(mapsPrimaryName(pineta).startsWith("Pineta Grande"), "nome primario Pineta");
ok(mapsMatchScore(pineta, "Villa Esther") >= 4, "accetta scheda Maps Villa Esther (sede operativa)");
ok(
  mapsMatchScore(pineta, "Pineta Grande Hospital") >= mapsMatchScore(pineta, "Villa Esther") - 2,
  "ospedale principale ancora competitivo"
);
const picked = pickOfficialWebsite(
  ["https://www.pinetagrande.it/", "https://www.villaesther.com/"],
  pineta
);
ok(picked?.includes("villaesther"), "pickOfficialWebsite trova villaesther.com per sede Villa Esther");
ok(
  extractCityFromMapsAddress("Via Roma, 81030 Castel Volturno CE, Italia") === "Castel Volturno",
  "estrazione città da indirizzo Maps"
);
ok(isBlockedWebsiteHost("facebook.com"), "blocca social");
ok(normalizeOfficialWebsite("https://www.pinetagrande.it/")?.includes("pinetagrande"), "normalizza sito ufficiale");

process.exit(failed ? 1 : 0);
