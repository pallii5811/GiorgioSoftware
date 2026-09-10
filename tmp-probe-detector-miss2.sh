#!/usr/bin/env bash
set -euo pipefail
cd /opt/leadsniper-revalidate/app
npx --yes tsx -e '
import { analyzePolicy } from "./src/lib/sanita/detector.ts";
import fs from "fs";

// re-implement debug by reading source helpers via dynamic - just dump analyze + raw match
const iatreion = "Polizza n. 747217409 Polizza di Assicurazione di Responsabilità civile verso terzi Descrizione Condizioni generali di assicurazione";
const galdiero = "Copertura assicurativa della responsabilità civile verso terzi e verso i prestatori d opera di Reale Mutua • Polizza 2022/03/2475660";

const re = /polizza\s+n[°º.]?\s*([A-Z0-9][A-Z0-9_./-]{4,})/i;
console.log("raw_match_iatreion", iatreion.match(re));
console.log("analyze", analyzePolicy(iatreion));
console.log("analyze_g", analyzePolicy(galdiero));

// Check if CRLF or BOM in detector breaks the regex literal
const src = fs.readFileSync("./src/lib/sanita/detector.ts");
const idx = src.indexOf(Buffer.from("polizza\\\\s+n"));
console.log("file_is_utf8_bom", src[0]===0xEF);
// extract the actual regex bytes around findPolicyNumber first polizza n pattern
const s = src.toString("utf8");
const m = s.match(/\/polizza\\s\+n\[[^\]]+\]\?\\s\*\\(\[A-Z0-9\]\[A-Z0-9_\.\/-\]\{4,\}\)\/i/);
console.log("extracted_re_src", m && m[0]);
if (m) {
  // eslint-disable-next-line no-eval
  const compiled = eval(m[0]);
  console.log("compiled_test", iatreion.match(compiled));
}
'
