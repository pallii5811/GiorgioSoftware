import fs from "fs";
import { analyzePolicy } from "../src/lib/sanita/detector.ts";

const pdfPath = process.argv[2] || "C:/Users/Simone/OneDrive/Desktop/Carta-Servizi-GEPOS-2025.pdf";
const buf = fs.readFileSync(pdfPath);
const { PDFParse } = await import("pdf-parse");
const p = new PDFParse({ data: buf });
const r = await p.getText();
const text = (r?.text || "").replace(/\s+/g, " ").trim();
console.log("LEN", text.length);
console.log("TITLE", text.slice(0, 120));
const hits = [
  "polizza",
  "assicuraz",
  "generali",
  "massimale",
  "art. 10",
  "gelli",
  "responsabilit",
  "carta dei servizi",
].map((k) => [k, text.toLowerCase().includes(k.replace(/\s/g, "")) || text.toLowerCase().includes(k)]);
console.log("HITS", Object.fromEntries(hits));
const a = analyzePolicy(text);
console.log("ANALYSIS", JSON.stringify(a, null, 2));
await p.destroy().catch(() => {});
