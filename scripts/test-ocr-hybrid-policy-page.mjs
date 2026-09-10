import assert from "node:assert/strict";
import sharp from "sharp";
import { PDFDocument, StandardFonts } from "pdf-lib";

process.env.OCR_ENABLED = "1";
process.env.OCR_MAX_PAGES = "20";
process.env.OCR_JOB_TIMEOUT_MS = "240000";

const { extractPdfFullText } = await import("../src/lib/sanita/ocr.ts");
const { detectPolicyCandidate } = await import("../src/lib/sanita/detector.ts");

const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
for (let pageNumber = 1; pageNumber <= 12; pageNumber++) {
  const page = pdf.addPage([595, 842]);
  const administrativeText =
    `Pagina ${pageNumber}. Informazioni amministrative, organizzazione sanitaria, servizi, orari, ` +
    "modalita di accesso, personale, prestazioni e standard di qualita della struttura. ".repeat(4);
  page.drawText(administrativeText, {
    x: 40,
    y: 760,
    size: 10,
    font,
    maxWidth: 510,
    lineHeight: 14,
  });
}

const policySvg = `
  <svg width="1240" height="1754" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="white"/>
    <text x="90" y="280" font-size="58" font-family="Arial">POLIZZA RESPONSABILITA CIVILE SANITARIA</text>
    <text x="90" y="420" font-size="58" font-family="Arial">Compagnia AMTRUST</text>
    <text x="90" y="560" font-size="58" font-family="Arial">Numero RCH00020000239</text>
    <text x="90" y="700" font-size="58" font-family="Arial">Scadenza 04/11/2026</text>
  </svg>`;
const policyPng = await sharp(Buffer.from(policySvg)).png().toBuffer();
const embedded = await pdf.embedPng(policyPng);
const policyPage = pdf.addPage([595, 842]);
policyPage.drawImage(embedded, { x: 0, y: 0, width: 595, height: 842 });

const bytes = Buffer.from(await pdf.save());
const extracted = await extractPdfFullText(bytes);
const detection = detectPolicyCandidate(extracted.text, "https://clinic.example/carta-servizi.pdf");

assert.equal(extracted.status, "OCR_SUCCESS", JSON.stringify(extracted));
assert.ok(
  detection.policy.policyFound || detection.candidate,
  `hybrid image-only policy page must be found: ${JSON.stringify(detection)}`
);
assert.equal(
  extracted.rasterize?.pageCount,
  1,
  `only the thin image-only page should need OCR: ${JSON.stringify(extracted.rasterize)}`
);

console.log(
  JSON.stringify({
    suite: "ocr-hybrid-policy-page",
    pass: 3,
    fail: 0,
    ocrPagesRead: extracted.rasterize?.pageCount,
    status: extracted.status,
    candidate: detection.candidate,
    policyFound: detection.policy.policyFound,
    exitCode: 0,
  })
);
