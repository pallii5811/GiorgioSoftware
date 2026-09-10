/** Smoke-test OCR diretto: verifica che il modello (fast) legga testo senza errore special-words. */
import sharp from "sharp";
import { createWorker } from "tesseract.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CACHE = process.env.TESS_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".tesseract-cache");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="220">
  <rect width="100%" height="100%" fill="white"/>
  <text x="20" y="90" font-family="DejaVu Sans" font-size="44" fill="black">Polizza RC numero RCH00020000157</text>
  <text x="20" y="160" font-family="DejaVu Sans" font-size="44" fill="black">Massimale Euro 5000000 AmTrust</text>
</svg>`;
const png = await sharp(Buffer.from(svg)).png().toBuffer();

const errors = [];
const origErr = console.error;
const origWarn = console.warn;
console.error = (...a) => { errors.push(a.join(" ")); };
console.warn = (...a) => { errors.push(a.join(" ")); };

const langPath = fs.existsSync(path.join(CACHE, "ita.traineddata"))
  ? CACHE
  : "https://tessdata.projectnaptha.com/4.0.0_fast";

const t0 = Date.now();
const worker = await createWorker("ita+eng", 1, {
  logger: () => {},
  cachePath: CACHE,
  langPath,
  errorHandler: (e) => errors.push(String(e)),
});
const { data: { text } } = await worker.recognize(png);
await worker.terminate();

console.error = origErr;
console.warn = origWarn;

console.log(`OCR done in ${Date.now() - t0}ms`);
console.log("TESTO:", JSON.stringify((text || "").replace(/\s+/g, " ").trim()));
console.log("RICONOSCIUTO_POLIZZA:", /polizz|massimale|rch?0002|5000000/i.test(text || ""));
console.log("SPECIAL_WORDS_ERROR:", errors.some((e) => /special-words/i.test(e)));
console.log("ERRORI_CATTURATI:", errors.slice(0, 5));
process.exit(0);
