#!/usr/bin/env node
import fs from "fs";
import { execFileSync } from "child_process";
import { extractPdfFullText, rasterizePdfPages, ocrPdfText } from "../src/lib/sanita/ocr.ts";

// Force OCR of pages around 6: build mini PDF? Or rasterize full and OCR page index 5
const buf = fs.readFileSync("/tmp/PARS_Malzoni-Research-Hospital_2026.pdf");
process.env.OCR_MAX_PAGES = "12";
process.env.OCR_ENABLED = "1";
process.env.PDFTOPPM_PATH = "/usr/bin/pdftoppm";
process.env.TESSDATA_PREFIX = "/opt/leadsniper-revalidate/app/.tesseract-cache";

const rast = await rasterizePdfPages(buf, { maxPages: 12 });
console.log("raster", rast.status, "pages", rast.pageCount, "images", rast.images.length);

// OCR only image index 5 (page 6)
import { createWorker } from "tesseract.js";
import path from "path";
import zlib from "zlib";

const cache = "/opt/leadsniper-revalidate/app/.tesseract-cache";
for (const lang of ["ita", "eng"]) {
  const raw = path.join(cache, `${lang}.traineddata`);
  const gz = path.join(cache, `${lang}.traineddata.gz`);
  if (fs.existsSync(raw) && !fs.existsSync(gz)) {
    fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(raw)));
    console.log("gzipped", lang);
  }
}

const worker = await createWorker("ita+eng", 1, { langPath: cache });
const img = rast.images[5] || rast.images[rast.images.length - 1];
fs.writeFileSync("/tmp/pars6-from-rast.png", img);
const { data } = await worker.recognize(img);
await worker.terminate();
const t = data.text || "";
fs.writeFileSync("/tmp/pars6-ocr.txt", t);
console.log(JSON.stringify({
  len: t.length,
  hasPhrase: /opera\s+sotto\s+il\s+regime\s+di\s+autoassicurazione/i.test(t),
  hasAuto: /autoassicur/i.test(t),
  snip: t.replace(/\s+/g, " ").slice(0, 900),
}));
