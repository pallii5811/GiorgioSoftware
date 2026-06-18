/**
 * Test OCR end-to-end su un PDF reale (URL o path locale).
 * Verifica: rasterizzazione poppler, normalizzazione sharp, testo estratto, verdetto.
 * Uso: npx tsx scripts/test-ocr.mjs <url|path>
 */
import fs from "node:fs";
import { collectPdfImagesForOcr, extractPdfFullText } from "../src/lib/sanita/ocr.ts";
import { analyzePolicy } from "../src/lib/sanita/detector.ts";

const src = process.argv[2];
if (!src) {
  console.error("Uso: npx tsx scripts/test-ocr.mjs <url|path>");
  process.exit(1);
}

let buf;
if (/^https?:\/\//.test(src)) {
  const res = await fetch(src);
  buf = Buffer.from(await res.arrayBuffer());
  console.log(`Scaricato ${buf.length} byte da ${src}`);
} else {
  buf = fs.readFileSync(src);
  console.log(`Letto ${buf.length} byte da ${src}`);
}

const t0 = Date.now();
const images = await collectPdfImagesForOcr(buf);
console.log(`\nIMMAGINI OCR raccolte: ${images.length} (in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
for (const [i, img] of images.entries()) {
  console.log(`  pagina ${i + 1}: ${img.length} byte (header ${img.subarray(0, 4).toString("hex")})`);
}

const t1 = Date.now();
const full = await extractPdfFullText(buf);
console.log(`\nESTRAZIONE TESTO (in ${((Date.now() - t1) / 1000).toFixed(1)}s):`);
console.log(`  digitale: ${full.digital.length} char`);
console.log(`  OCR: ${full.ocr ? full.ocr.length : 0} char`);
console.log(`  testo finale: ${full.text.length} char`);
console.log(`  estratto OCR: ${(full.ocr || "").slice(0, 300)}`);

const a = analyzePolicy(full.text);
console.log(`\nVERDETTO DETECTOR:`);
console.log(`  policyFound=${a.policyFound} company=${a.company} massimale=${a.massimale} expiry=${a.expiry} n=${a.policyNumber}`);
process.exit(0);
