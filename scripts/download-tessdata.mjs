/**
 * Scarica traineddata ita+eng in locale (no fetch a runtime).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { externalFetch } from "../src/lib/http.ts";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".tesseract-cache");
const BASE = "https://tessdata.projectnaptha.com/4.0.0";

fs.mkdirSync(dir, { recursive: true });

for (const lang of ["ita", "eng"]) {
  const out = path.join(dir, `${lang}.traineddata`);
  if (fs.existsSync(out) && fs.statSync(out).size > 1_000_000) {
    console.log(`✓ ${lang} già presente`);
    continue;
  }
  const url = `${BASE}/${lang}.traineddata.gz`;
  console.log(`Scarico ${url}…`);
  const res = await externalFetch(url, { timeoutMs: 120_000 });
  if (!res.ok) throw new Error(`HTTP ${res.status} per ${lang}`);
  const gz = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(out, gunzipSync(gz));
  console.log(`✓ ${lang} → ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
}

console.log(`\nTessdata pronti in ${dir}\n`);
