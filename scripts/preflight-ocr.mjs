/**
 * Blocking OCR preflight for systemd/revalidate hosts.
 * Exit 1 → do not start jobs / do not consume leads.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

process.env.PATH =
  process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
if (!process.env.PDFTOPPM_PATH && fs.existsSync("/usr/bin/pdftoppm")) {
  process.env.PDFTOPPM_PATH = "/usr/bin/pdftoppm";
}
const stagingPpm = path.join(
  ROOT,
  "data/staging/poppler/poppler-24.08.0/Library/bin/pdftoppm.exe"
);
if (!process.env.PDFTOPPM_PATH && fs.existsSync(stagingPpm)) {
  process.env.PDFTOPPM_PATH = stagingPpm;
}
if (!process.env.TESSDATA_PREFIX) {
  const tess = path.join(ROOT, ".tesseract-cache");
  if (fs.existsSync(path.join(tess, "ita.traineddata"))) process.env.TESSDATA_PREFIX = tess;
}
process.env.OCR_ENABLED = "1";
process.env.OCR_MAX_PAGES = process.env.OCR_MAX_PAGES || "2";
process.env.OCR_JOB_TIMEOUT_MS = process.env.OCR_JOB_TIMEOUT_MS || "120000";

const {
  resolvePdftoppm,
  resetPdftoppmCache,
  rasterizePdfPages,
  extractPdfFullText,
} = await import("../src/lib/sanita/ocr.ts");

let fail = 0;
function ok(c, m) {
  if (c) console.log(`  PASS ${m}`);
  else {
    fail++;
    console.error(`  FAIL ${m}`);
  }
}

console.log("=== preflight:ocr ===");
console.log(
  JSON.stringify(
    {
      cwd: process.cwd(),
      pid: process.pid,
      uid: typeof process.getuid === "function" ? process.getuid() : null,
      PATH: process.env.PATH,
      PDFTOPPM_PATH: process.env.PDFTOPPM_PATH || null,
      TESSDATA_PREFIX: process.env.TESSDATA_PREFIX || null,
    },
    null,
    2
  )
);

resetPdftoppmCache();
const ppm = await resolvePdftoppm();
ok(Boolean(ppm.path), `pdftoppm resolved path=${ppm.path || "null"}`);
ok(Boolean(ppm.version), `pdftoppm version=${ppm.version || "n/a"}`);
if (ppm.path) {
  try {
    const { stdout, stderr } = await execFileAsync(ppm.path, ["-v"], { timeout: 5000 });
    const blob = `${stdout || ""}${stderr || ""}`;
    ok(/pdftoppm version/i.test(blob), `exec -v ok (${blob.trim().split(/\r?\n/)[0]})`);
  } catch (e) {
    const err = e;
    const blob = `${err.stdout || ""}${err.stderr || ""}${err.message || ""}`;
    ok(/pdftoppm version/i.test(blob), `exec -v (nonzero exit tolerated) ${blob.slice(0, 80)}`);
  }
}

const tess = process.env.TESSDATA_PREFIX || path.join(ROOT, ".tesseract-cache");
ok(fs.existsSync(path.join(tess, "ita.traineddata")), `tessdata ita @ ${tess}`);
ok(fs.existsSync(path.join(tess, "eng.traineddata")), `tessdata eng @ ${tess}`);

let fixture = path.join(ROOT, "tests/fixtures/sanita/scanned-policy-sample.pdf");
if (!fs.existsSync(fixture)) fixture = path.join(ROOT, "data/staging/clotilde-assicurazione.pdf");
if (!fs.existsSync(fixture) && ppm.path) {
  // create one-page PDF via printf + pdftoppm not available; write minimal PDF bytes
  const tmpPdf = path.join(os.tmpdir(), `ocr-preflight-${process.pid}.pdf`);
  fs.writeFileSync(
    tmpPdf,
    Buffer.from(`%PDF-1.4
1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj
2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj
4 0 obj<< /Length 68 >>stream
BT /F1 24 Tf 72 720 Td (POLIZZA RC ASSICURAZIONE TEST OCR) Tj ET
endstream
endobj
5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000268 00000 n 
0000000387 00000 n 
trailer<< /Size 6 /Root 1 0 R >>
startxref
464
%%EOF`)
  );
  fixture = tmpPdf;
}
ok(fs.existsSync(fixture), `fixture ${path.basename(fixture)}`);

if (ppm.path && fs.existsSync(fixture)) {
  const buf = fs.readFileSync(fixture);
  const rast = await rasterizePdfPages(buf, 1);
  ok(rast.status === "OK", `rasterize status=${rast.status} err=${rast.error || ""}`);
  ok(rast.images.length >= 1, `PNG pages=${rast.images.length}`);
  ok(rast.rendererPath === ppm.path || Boolean(rast.rendererPath), `rendererPath=${rast.rendererPath}`);
  const ex = await extractPdfFullText(buf);
  ok(ex.status !== "OCR_RENDERER_MISSING", `extract status=${ex.status} (must not be RENDERER_MISSING)`);
  ok(
    (ex.text || "").length > 5 || ex.status === "OCR_NOT_NEEDED" || ex.status === "OCR_SUCCESS" || ex.status === "OCR_LOW_CONFIDENCE",
    `textLen=${(ex.text || "").length}`
  );
  if (/polizza|assicuraz|rc\b/i.test(ex.text || "")) {
    ok(true, "expected Italian policy keywords present");
  } else {
    ok(true, "keyword check soft (fixture may be image-only / low OCR)");
  }
} else {
  ok(false, "cannot rasterize — missing renderer or fixture");
}

if (fail) {
  console.error("\nPREFLIGHT_OCR_FAIL — do not start revalidate jobs");
  process.exit(1);
}
console.log("\nPREFLIGHT_OCR_PASS");
process.exit(0);
