#!/usr/bin/env bash
set -euo pipefail
cd /opt/leadsniper-revalidate/app
npx --yes tsx -e '
const texts = [
  "Polizza n. 747217409 Polizza di Assicurazione di Responsabilità civile verso terzi",
  "Reale Mutua • Polizza 2022/03/2475660",
];
const patterns = [
  /polizza\s+n[°º.]?\s*([A-Z0-9][A-Z0-9_./-]{4,})/i,
  /polizza\s+n\.?\s*([A-Z0-9][A-Z0-9_./-]{4,})/i,
  /polizza\s+n[°º.]?\s*(\d{5,})/i,
  /polizza\s+(\d{4}\/\d{2}\/\d+)/i,
  /polizza\s+([A-Z0-9][A-Z0-9_./-]{5,})/i,
  /Reale\s+Mutua/i,
];
for (const t of texts) {
  console.log("TEXT", t);
  for (const re of patterns) {
    console.log(" ", re, "->", t.match(re)?.[1] ?? t.match(re)?.[0] ?? null);
  }
}
// show actual bytes of detector pattern line
import fs from "fs";
const src = fs.readFileSync("./src/lib/sanita/detector.ts","utf8");
const line = src.split(/\n/).find(l => l.includes("polizza\\s+n"));
console.log("DETECTOR_LINE", JSON.stringify(line));
'
