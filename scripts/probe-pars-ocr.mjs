import { readFileSync } from "fs";
import { extractPdfFullText } from "../src/lib/sanita/ocr.ts";
import { analyzePolicy, isGelliComplianceReportText } from "../src/lib/sanita/detector.ts";
import { terminateOcrWorker } from "../src/lib/sanita/ocr.ts";

const path = process.argv[2] || "/tmp/malzoni-pars.pdf";
const buf = readFileSync(path);
const { text, digital, ocr } = await extractPdfFullText(buf);
console.log("digital", digital?.length ?? 0, "ocr", ocr?.length ?? 0, "total", text.length);
console.log("sample", text.replace(/\s+/g, " ").slice(0, 600));
console.log("autoassicur", /autoassicur/i.test(text));
console.log("gestione diretta", /gestione\s+diretta/i.test(text));
console.log("compliance", isGelliComplianceReportText(text));
console.log("policy", JSON.stringify(analyzePolicy(text), null, 2));
await terminateOcrWorker().catch(() => {});
