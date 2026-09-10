#!/usr/bin/env node
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
// use same entry as test-suite
const ocr = await import("../src/lib/sanita/ocr.ts");
const fn = ocr.extractPdfFullText || ocr.ocrPdfText;
const buf = fs.readFileSync("/tmp/PARS_Malzoni-Research-Hospital_2026.pdf");
const r = await (ocr.extractPdfFullText ? ocr.extractPdfFullText(buf) : ocr.ocrPdfText(buf));
const t = (r && r.text) || "";
console.log(JSON.stringify({
  keys: Object.keys(ocr),
  status: r?.status,
  len: t.length,
  hasPhrase: /opera\s+sotto\s+il\s+regime\s+di\s+autoassicurazione/i.test(t),
  snip: t.replace(/\s+/g, " ").match(/.{0,80}autoassicurazione.{0,80}/i)?.[0] || null,
}));
