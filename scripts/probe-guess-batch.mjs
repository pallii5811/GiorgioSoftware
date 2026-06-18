import { probeGuessedOfficialWebsite } from "../src/lib/sanita/guess-website.ts";

const names = [
  "Casa Di Cura Villa Dei Platani",
  "Casa Di Cura Montevergine",
  "Casa Di Cura San Francesco",
  "Casa Di Cura Villa Maria BAIANO",
  "Casa Di Cura S.Rita",
];

for (const n of names) {
  const u = await probeGuessedOfficialWebsite(n);
  console.log(n, "->", u || "NONE");
}
