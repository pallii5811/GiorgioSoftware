import fs from "fs";
import { analyzePolicy } from "../src/lib/sanita/detector.ts";
import { pickOfficialWebsite } from "../src/lib/sanita/contacts.ts";

const pdfPath = process.argv[2];
const buf = fs.readFileSync(pdfPath);
const { PDFParse } = await import("pdf-parse");
const p = new PDFParse({ data: buf });
const r = await p.getText();
const text = (r?.text || "").replace(/\s+/g, " ");
console.log("TEXT:\n", text.slice(0, 1200));
console.log("\nANALYSIS:", JSON.stringify(analyzePolicy(text), null, 2));

const urls = [
  "https://www.clinicavillamaria.it/",
  "https://www.casadicuravillamaria.it/",
  "https://www.micuro.it/",
];
console.log(
  "\nPICK:",
  pickOfficialWebsite(urls, "Casa Di Cura Villa Maria BAIANO")
);
await p.destroy().catch(() => {});
