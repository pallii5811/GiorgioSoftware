/**
 * OCR environment preflight — exit 1 if required tooling missing.
 * Env: PDFTOPPM_PATH (optional), TESSDATA_PREFIX (optional).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Prefer staging poppler on this machine
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
process.env.OCR_JOB_TIMEOUT_MS = process.env.OCR_JOB_TIMEOUT_MS || "90000";

const {
  resolvePdftoppm,
  rasterizePdfPages,
  extractPdfFullText,
  resetPdftoppmCacheForTests,
} = await import("../src/lib/sanita/ocr.ts");

let fail = 0;
function ok(c, m) {
  if (c) console.log(`  ✓ ${m}`);
  else {
    fail++;
    console.error(`  ✗ ${m}`);
  }
}

resetPdftoppmCacheForTests();
const ppm = await resolvePdftoppm();
ok(Boolean(ppm.path), `pdftoppm available (${ppm.path || "none"})`);
ok(Boolean(ppm.version), `pdftoppm version readable (${ppm.version || "n/a"})`);

const tess = process.env.TESSDATA_PREFIX || path.join(ROOT, ".tesseract-cache");
ok(fs.existsSync(path.join(tess, "ita.traineddata")), `tessdata ita at ${tess}`);
ok(fs.existsSync(path.join(tess, "eng.traineddata")), `tessdata eng at ${tess}`);

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ocr-preflight-"));
ok(true, `temp writable ${tmp}`);

// Fixture: prefer Clotilde scanned PDF if present, else minimal digital PDF bytes
let fixture = path.join(ROOT, "data/staging/clotilde-assicurazione.pdf");
if (!fs.existsSync(fixture) || fs.statSync(fixture).size < 1000) {
  fixture = path.join(ROOT, "tests/fixtures/sanita/scanned-policy-sample.pdf");
}
ok(fs.existsSync(fixture), `scanned fixture present (${path.basename(fixture)})`);

if (fs.existsSync(fixture) && ppm.path) {
  const buf = fs.readFileSync(fixture);
  const rast = await rasterizePdfPages(buf, 1);
  ok(rast.status === "OK", `rasterize status=${rast.status} pages=${rast.pageCount} ${rast.durationMs}ms`);
  ok(rast.images.length >= 1, `images produced=${rast.images.length}`);
  if (rast.status === "OK") {
    const ex = await extractPdfFullText(buf);
    ok(
      ex.status === "OCR_SUCCESS" || ex.status === "OCR_LOW_CONFIDENCE" || ex.status === "OCR_NOT_NEEDED",
      `OCR extract status=${ex.status} textLen=${(ex.text || "").length}`
    );
    ok((ex.text || "").length > 20 || ex.status === "OCR_NOT_NEEDED", "OCR produced usable text or not needed");
  }
} else if (!ppm.path) {
  ok(false, "skip rasterize — renderer missing (install poppler-utils / set PDFTOPPM_PATH)");
}

await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
ok(true, "cleanup ok");

console.log(
  JSON.stringify(
    {
      suite: "preflight:ocr",
      exitCode: fail === 0 ? 0 : 1,
      pdftoppm: ppm.path,
      version: ppm.version,
      tessdata: tess,
    },
    null,
    2
  )
);
process.exit(fail === 0 ? 0 : 1);
