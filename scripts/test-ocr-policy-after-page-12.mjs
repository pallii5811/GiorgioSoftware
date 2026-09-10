import assert from "node:assert/strict";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";

process.env.OCR_ENABLED = "1";
process.env.OCR_MAX_PAGES = "20";
process.env.OCR_JOB_TIMEOUT_MS = "240000";

const { extractPdfFullText } = await import("../src/lib/sanita/ocr.ts");
const { detectPolicyCandidate } = await import("../src/lib/sanita/detector.ts");

const pdf = await PDFDocument.create();
for (let pageNumber = 1; pageNumber <= 13; pageNumber++) {
  const policyText =
    pageNumber === 13
      ? [
          "POLIZZA ASSICURATIVA RESPONSABILITA CIVILE",
          "Compagnia: AMTRUST",
          "Numero polizza: RCH00020000239",
          "Scadenza: 04/11/2026",
        ]
      : [
          `PAGINA ${pageNumber}`,
          "Documento amministrativo della struttura sanitaria",
          "Informazioni generali e organizzazione dei servizi",
        ];
  const svg = `
    <svg width="1240" height="1754" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="white"/>
      ${policyText
        .map(
          (line, index) =>
            `<text x="100" y="${260 + index * 130}" font-size="58" font-family="Arial" fill="black">${line}</text>`
        )
        .join("")}
    </svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const embedded = await pdf.embedPng(png);
  const page = pdf.addPage([595, 842]);
  page.drawImage(embedded, { x: 0, y: 0, width: 595, height: 842 });
}

const bytes = Buffer.from(await pdf.save());
const extracted = await extractPdfFullText(bytes);
const detection = detectPolicyCandidate(extracted.text, "https://clinic.example/polizza.pdf");

assert.equal(extracted.status, "OCR_SUCCESS", JSON.stringify(extracted));
assert.ok(
  detection.policy.policyFound || detection.candidate,
  `policy on page 13 must be found: ${JSON.stringify(detection)}`
);
assert.ok(
  (extracted.rasterize?.pageCount ?? 0) >= 13,
  `OCR must pass the old 12-page boundary: ${JSON.stringify(extracted.rasterize)}`
);

console.log(
  JSON.stringify({
    suite: "ocr-policy-after-page-12",
    pass: 3,
    fail: 0,
    pagesRead: extracted.rasterize?.pageCount,
    status: extracted.status,
    candidate: detection.candidate,
    policyFound: detection.policy.policyFound,
    exitCode: 0,
  })
);
