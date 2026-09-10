#!/usr/bin/env bash
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
cd "$APP"
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PDFTOPPM_PATH=/usr/bin/pdftoppm
export TESSDATA_PREFIX=/opt/leadsniper-revalidate/app/.tesseract-cache
export OCR_ENABLED=1

cat > /tmp/stopship-ocr-diag/probe-maione-pdf.mjs <<'EOF'
import { writeFileSync } from "node:fs";
import {
  extractPdfFullText,
  resetPdftoppmCache,
  resolvePdftoppm,
} from "../src/lib/sanita/ocr.ts";

const url =
  "https://www.villamaione.com/wp-content/uploads/2026/03/CERT_PDR125-CLINICA-VILLA-MAIONE.pdf";

async function main() {
  resetPdftoppmCache();
  const resolved = await resolvePdftoppm();
  console.log("resolved", JSON.stringify(resolved));
  const res = await fetch(url, { redirect: "follow" });
  const buf = Buffer.from(await res.arrayBuffer());
  console.log("pdfBytes", buf.length, "http", res.status);

  process.env.OCR_ENABLED = "0";
  resetPdftoppmCache();
  const withGate = await extractPdfFullText(buf);
  console.log(
    "OCR_ENABLED=0",
    JSON.stringify({
      status: withGate.status,
      reasonCode: withGate.reasonCode,
      digitalLen: withGate.digital?.length,
      ocrLen: withGate.ocr?.length ?? 0,
      textLen: withGate.text?.length,
      textPreview: (withGate.text || "").slice(0, 200),
      rendererPath: withGate.rasterize?.rendererPath ?? null,
      rasterizeStatus: withGate.rasterize?.status ?? null,
      pageCount: withGate.rasterize?.pageCount ?? null,
    }),
  );

  process.env.OCR_ENABLED = "1";
  resetPdftoppmCache();
  const withOcr = await extractPdfFullText(buf);
  console.log(
    "OCR_ENABLED=1",
    JSON.stringify({
      status: withOcr.status,
      reasonCode: withOcr.reasonCode,
      digitalLen: withOcr.digital?.length,
      ocrLen: withOcr.ocr?.length ?? 0,
      textLen: withOcr.text?.length,
      textPreview: (withOcr.text || "").slice(0, 200),
      rendererPath: withOcr.rasterize?.rendererPath ?? null,
      rasterizeStatus: withOcr.rasterize?.status ?? null,
      pageCount: withOcr.rasterize?.pageCount ?? null,
    }),
  );

  writeFileSync(
    "/tmp/stopship-ocr-diag/maione-pdf-ocr-probe.json",
    JSON.stringify(
      {
        resolved,
        withGate: {
          status: withGate.status,
          reasonCode: withGate.reasonCode,
          digital: withGate.digital?.slice(0, 200),
          ocr: withGate.ocr?.slice(0, 400),
          text: withGate.text?.slice(0, 400),
          rasterize: withGate.rasterize
            ? {
                status: withGate.rasterize.status,
                rendererPath: withGate.rasterize.rendererPath,
                pageCount: withGate.rasterize.pageCount,
                imageCount: withGate.rasterize.images?.length,
              }
            : null,
        },
        withOcr: {
          status: withOcr.status,
          reasonCode: withOcr.reasonCode,
          digital: withOcr.digital?.slice(0, 200),
          ocr: withOcr.ocr?.slice(0, 400),
          text: withOcr.text?.slice(0, 400),
          rasterize: withOcr.rasterize
            ? {
                status: withOcr.rasterize.status,
                rendererPath: withOcr.rasterize.rendererPath,
                pageCount: withOcr.rasterize.pageCount,
                imageCount: withOcr.rasterize.images?.length,
              }
            : null,
        },
      },
      null,
      2,
    ),
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
EOF

# run from scripts/ for relative import
cp /tmp/stopship-ocr-diag/probe-maione-pdf.mjs "$APP/scripts/_probe-maione-pdf.mjs"
npx tsx scripts/_probe-maione-pdf.mjs
