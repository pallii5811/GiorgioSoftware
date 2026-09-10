#!/bin/bash
set -euo pipefail
PDF=/tmp/PARM_2025_pini.pdf
APP=/opt/leadsniper-revalidate/app
export TESSDATA_PREFIX="$APP/.tesseract-cache"
# How many pages?
pdfinfo "$PDF" 2>/dev/null | head -5 || python3 - <<'PY'
from pypdf import PdfReader
print('pages', len(PdfReader('/tmp/PARM_2025_pini.pdf').pages))
PY

# Render pages 6-10 and OCR for Revo / 0X000469
rm -rf /tmp/parm_scan
mkdir -p /tmp/parm_scan
pdftoppm -f 6 -l 12 -png -r 180 "$PDF" /tmp/parm_scan/p
cd "$APP"
node --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { createWorker } from "tesseract.js";
const cache = "/opt/leadsniper-revalidate/app/.tesseract-cache";
process.env.TESSDATA_PREFIX = cache;
const prev = process.cwd();
process.chdir(cache);
const dir = "/tmp/parm_scan";
const files = fs.readdirSync(dir).filter(f => f.endsWith(".png")).sort();
const w = await createWorker(["ita", "eng"], 1, { cachePath: cache, langPath: cache, logger: () => {} });
try {
  for (const f of files) {
    const img = path.join(dir, f);
    const { data } = await w.recognize(img);
    const text = data.text || "";
    fs.writeFileSync(path.join(dir, f.replace(".png", ".txt")), text, "utf8");
    const hit = /0X000469|000469|Revo|2025|autoassicur/i.test(text);
    console.log("PAGEFILE", f, "chars", text.length, "HIT", hit);
    if (hit) {
      const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean);
      for (const l of lines) {
        if (/0X000469|000469|Revo|autoassicur|2025|polizza/i.test(l)) console.log(" ", l.slice(0, 160));
      }
    }
  }
} finally {
  await w.terminate();
  try { process.chdir(prev); } catch {}
}
NODE
