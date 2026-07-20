/**
 * Scarica i modelli OCR italiani+inglese in locale (.tesseract-cache).
 * Usa tessdata_fast: niente bug "ita.special-words", ~10x più veloce del tessdata standard.
 * I file su GitHub sono .traineddata diretti (non gzippati).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { externalFetch } from "../src/lib/http.ts";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".tesseract-cache");
const BASE =
  process.env.TESSDATA_BASE || "https://github.com/tesseract-ocr/tessdata_fast/raw/main";
const FORCE = process.argv.includes("--force");

fs.mkdirSync(dir, { recursive: true });

for (const lang of ["ita", "eng"]) {
  const out = path.join(dir, `${lang}.traineddata`);
  if (!FORCE && fs.existsSync(out) && fs.statSync(out).size > 1_000_000) {
    console.log(`✓ ${lang} già presente`);
    continue;
  }
  const url = `${BASE}/${lang}.traineddata`;
  console.log(`Scarico ${url}…`);
  const res = await externalFetch(url, { timeoutMs: 120_000, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} per ${lang}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1_000_000) throw new Error(`File ${lang} troppo piccolo (${buf.length} byte)`);
  // Scrittura atomica: tmp + rename (non corrompe letture concorrenti di worker OCR attivi).
  const tmp = `${out}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, out);
  console.log(`✓ ${lang} → ${out} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

console.log(`\nTessdata pronti in ${dir}\n`);
