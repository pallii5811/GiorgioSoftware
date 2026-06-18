import { readFileSync } from "fs";
import { extractPdfFullText, terminateOcrWorker } from "../src/lib/sanita/ocr.ts";
import {
  analyzePolicy,
  hasArt10RcOrSelfInsurancePublication,
  isGelliComplianceReportOnly,
  isGelliComplianceReportText,
} from "../src/lib/sanita/detector.ts";

const url =
  "https://www.villadeifioriacerra.it/wp-content/uploads/2026/04/PARM-2026-VILLA-DEI-FIORI-.pdf";
const pdfPath = process.argv[2];

let buf;
if (pdfPath) {
  buf = readFileSync(pdfPath);
} else {
  const res = await fetch(url);
  buf = Buffer.from(await res.arrayBuffer());
}

const { text, digital, ocr } = await extractPdfFullText(buf);
console.log("digital", digital?.length ?? 0, "ocr", ocr?.length ?? 0, "total", text.length);
const t = text.replace(/\s+/g, " ");
console.log("art10/self", hasArt10RcOrSelfInsurancePublication(t));
console.log("complianceText", isGelliComplianceReportText(t));
console.log("complianceOnly", isGelliComplianceReportOnly(t, url));
console.log("policy", JSON.stringify(analyzePolicy(text), null, 2));

const ins = t.search(/polizza\s+assicurativa\s+per\s+RCT/i);
if (ins >= 0) console.log("--- insurance block", t.slice(Math.max(0, ins - 400), ins + 1200));

await terminateOcrWorker().catch(() => {});
