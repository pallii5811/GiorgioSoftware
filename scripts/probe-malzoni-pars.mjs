import { readFileSync } from "fs";
import { analyzePolicy, isGelliComplianceReportPdf, isGelliComplianceReportText } from "../src/lib/sanita/detector.ts";
import { extractPdfFullText } from "../src/lib/sanita/ocr.ts";

const pdfPath =
  "c:/Users/Simone/OneDrive/Documenti/PARS-2025-Malzoni-Research-Hospital-S.p.A.pdf";
const url =
  "https://www.malzoni.it/wp-content/uploads/PARS-2025-Malzoni-Research-Hospital-S.p.A.pdf";

const buf = readFileSync(pdfPath);
const { text, digital, ocr } = await extractPdfFullText(buf);
console.log("digital", digital, "ocr", ocr, "chars", text.length);
console.log("sample:", text.slice(0, 800));
console.log("isGelliComplianceReportPdf", isGelliComplianceReportPdf(url));
console.log("isGelliComplianceReportText", isGelliComplianceReportText(text));
console.log("analyzePolicy", JSON.stringify(analyzePolicy(text), null, 2));
