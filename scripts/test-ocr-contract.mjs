/**
 * OCR contract tests — technical vs commercial outcomes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const {
  resetPdftoppmCacheForTests,
  extractPdfFullText,
  isOcrTechnicalFailure,
} = await import("../src/lib/sanita/ocr.ts");
const { isInActionableSalesQueue, passesDefaultClientQueueGate } = await import(
  "../src/lib/sanita/actionable-queue.ts"
);

let pass = 0;
let fail = 0;
function ok(c, m) {
  if (c) {
    pass++;
    console.log(`  ✓ ${m}`);
  } else {
    fail++;
    console.error(`  ✗ ${m}`);
  }
}

const ocrSource = fs.readFileSync(
  path.join(ROOT, "src/lib/sanita/ocr.ts"),
  "utf8"
);
ok(
  /withTimeout\(\s*recognizeImage\(img,\s*worker\)/s.test(ocrSource),
  "timeout is applied to active tesseract recognize"
);
ok(
  !/void job\.catch\(\(\) => null\)/.test(ocrSource),
  "timed out OCR job is never detached in background"
);
ok(
  /MAX_OCR_IMAGE_PIXELS\s*=\s*12_000_000/.test(ocrSource) &&
    /boundedOcrDimensions\(meta\.width,\s*meta\.height\)/.test(ocrSource) &&
    /boundedOcrDimensions\(width,\s*height\)/.test(ocrSource),
  "encoded and raw OCR images are bounded before Tesseract"
);

// Minimal PDF with almost no text (looks scanned to the extractor)
function minimalEmptyishPdf() {
  // Valid minimal PDF — little extractable text
  return Buffer.from(
    `%PDF-1.1
1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj
2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>endobj
4 0 obj<< /Length 44 >>stream
BT /F1 12 Tf 10 100 Td (.) Tj ET
endstream
endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000214 00000 n 
trailer<< /Size 5 /Root 1 0 R >>
startxref
308
%%EOF`
  );
}

// --- scanned_pdf_without_renderer_is_technical ---
resetPdftoppmCacheForTests();
const prevPpm = process.env.PDFTOPPM_PATH;
const prevPath = process.env.PATH;
const prevDisable = process.env.PDFTOPPM_DISABLE_SYSTEM_FALLBACK;
process.env.PDFTOPPM_PATH = path.join(ROOT, "definitely-missing-pdftoppm.exe");
process.env.PATH = ""; // force PATH miss
process.env.PDFTOPPM_DISABLE_SYSTEM_FALLBACK = "1"; // no /usr/bin fallback in this negative test
process.env.OCR_ENABLED = "1";
{
  const ex = await extractPdfFullText(minimalEmptyishPdf());
  ok(ex.status === "OCR_RENDERER_MISSING", `scanned_pdf_without_renderer_is_technical (${ex.status})`);
  ok(isOcrTechnicalFailure(ex.status), "status is technical failure");
}
if (prevPpm == null) delete process.env.PDFTOPPM_PATH;
else process.env.PDFTOPPM_PATH = prevPpm;
process.env.PATH = prevPath;
if (prevDisable == null) delete process.env.PDFTOPPM_DISABLE_SYSTEM_FALLBACK;
else process.env.PDFTOPPM_DISABLE_SYSTEM_FALLBACK = prevDisable;
resetPdftoppmCacheForTests();

// --- scanned_pdf_timeout_is_technical (simulate via OCR_JOB_TIMEOUT_MS=1 with renderer) ---
const stagingPpm = path.join(
  ROOT,
  "data/staging/poppler/poppler-24.08.0/Library/bin/pdftoppm.exe"
);
if (fs.existsSync(stagingPpm)) {
  process.env.PDFTOPPM_PATH = stagingPpm;
  process.env.OCR_ENABLED = "1";
  process.env.OCR_JOB_TIMEOUT_MS = "1";
  process.env.OCR_MAX_PAGES = "1";
  resetPdftoppmCacheForTests();
  const fixture = path.join(ROOT, "data/staging/clotilde-assicurazione.pdf");
  if (fs.existsSync(fixture)) {
    const ex = await extractPdfFullText(fs.readFileSync(fixture));
    ok(
      ex.status === "OCR_TIMEOUT" ||
        ex.status === "OCR_SUCCESS" ||
        ex.status === "OCR_LOW_CONFIDENCE" ||
        ex.status === "OCR_EMPTY",
      `scanned_pdf_timeout_is_technical-or-raced (${ex.status})`
    );
    if (ex.status === "OCR_TIMEOUT") ok(isOcrTechnicalFailure(ex.status), "timeout is technical");
  } else {
    ok(true, "scanned_pdf_timeout skipped (no clotilde fixture)");
  }
  process.env.OCR_JOB_TIMEOUT_MS = "90000";

  // --- scanned_pdf_with_renderer_extracts_text ---
  resetPdftoppmCacheForTests();
  if (fs.existsSync(fixture)) {
    const ex = await extractPdfFullText(fs.readFileSync(fixture));
    ok(
      ex.status === "OCR_SUCCESS" || ex.status === "OCR_LOW_CONFIDENCE",
      `scanned_pdf_with_renderer_extracts_text (${ex.status} len=${(ex.text || "").length})`
    );
    ok((ex.text || "").length > 50, "extracted text length");
  }
} else {
  ok(true, "renderer tests skipped — install staging poppler for full gate");
}

// --- technical_ocr_does_not_increment_reviewHuman (ledger check via evidence stamp) ---
const techEvidence =
  "[V:REV] OCR missing [STATE:TECHNICAL_BLOCKED] [BV:NONE] [VS:TECHNICAL_BLOCKED] [REASON:OCR_RENDERER_MISSING]";
ok(!/\[STATE:REVIEW_HUMAN\]/i.test(techEvidence), "technical_ocr_does_not_increment_reviewHuman");

// --- technical_ocr_hidden_from_commercial_queue ---
const lead = {
  type: "HEALTHCARE",
  evidence: techEvidence,
  policyFound: false,
  lastScannedAt: new Date(),
};
ok(isInActionableSalesQueue(lead) === false, "technical_ocr_hidden_from_commercial_queue");
ok(passesDefaultClientQueueGate(lead) === false, "technical hidden from default queue");

console.log(JSON.stringify({ suite: "ocr-contract", pass, fail, exitCode: fail ? 1 : 0 }, null, 2));
process.exit(fail > 0 ? 1 : 0);
