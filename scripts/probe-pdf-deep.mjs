import fs from "fs";
import { analyzePolicy, isGelliComplianceReportPdf, isGelliComplianceReportText } from "../src/lib/sanita/detector.ts";

const pdfPath = process.argv[2];
const url = process.argv[3] || pdfPath;
const buf = fs.readFileSync(pdfPath);
const { PDFParse } = await import("pdf-parse");
const p = new PDFParse({ data: buf });
const r = await p.getText();
const text = (r?.text || "").replace(/\s+/g, " ");
console.log("URL match compliance?", isGelliComplianceReportPdf(url));
console.log("TEXT match compliance?", isGelliComplianceReportText(text.slice(0, 15000)));
console.log("TEXT head:", text.slice(0, 800));
for (const term of ["polizza", "generali", "massimale", "art. 10", "gelli", "risk management", "gestione del rischio", "codice polizza", "appendice"]) {
  const idx = text.toLowerCase().indexOf(term);
  if (idx >= 0) console.log(`\n--- ${term} @${idx} ---\n`, text.slice(Math.max(0, idx - 60), idx + 200));
}
const a = analyzePolicy(text);
console.log("\nANALYSIS", JSON.stringify(a, null, 2));
await p.destroy().catch(() => {});
