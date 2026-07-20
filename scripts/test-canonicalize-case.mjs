import { canonicalizeUrl } from "../src/lib/sanita/frontier-store.ts";

let pass = 0;
let fail = 0;
function ok(c, m) {
  if (c) {
    pass++;
    console.log(`  ✓ ${m}`);
  } else {
    fail++;
    console.error(`  ✗ ${m}`);
  }
}

const mixed =
  "https://www.FondazioneClotilde.it/wp-content/uploads/2024/12/Assicurazione-Rischi-Avversi-Fondazione-Clotilde.pdf";
const can = canonicalizeUrl(mixed);
ok(can.includes("Assicurazione-Rischi-Avversi"), `path case preserved: ${can}`);
ok(can.startsWith("https://www.fondazioneclotilde.it/"), `host lowercased: ${can}`);
ok(!can.includes("assicurazione-rischi-avversi-fondazione"), "does not force lowercase path");

console.log(JSON.stringify({ suite: "canonicalize-case", pass, fail, exitCode: fail ? 1 : 0 }, null, 2));
process.exit(fail ? 1 : 0);
