import fs from "node:fs";
import { PDFParse } from "pdf-parse";
import { analyzePolicy, detectPolicyCandidate } from "../src/lib/sanita/detector.ts";

const pdfPath = process.argv[2];
if (!pdfPath) throw new Error("PDF path required");
const parser = new PDFParse({ data: fs.readFileSync(pdfPath) });
const parsed = await parser.getText();
await parser.destroy();
const analysis = analyzePolicy(parsed.text, pdfPath);
const candidate = detectPolicyCandidate(parsed.text, pdfPath);
console.log(
  JSON.stringify(
    {
      textLength: parsed.text.length,
      analysis: {
        ...analysis,
        expiry: analysis.expiry?.toISOString() ?? null,
      },
      candidate: {
        candidate: candidate.candidate,
        resolved: candidate.resolved,
        reasons: candidate.reasons,
      },
    },
    null,
    2
  )
);
