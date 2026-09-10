/**
 * OCR pipeline — structured status, never silent empty on missing renderer.
 */
import { createWorker, type Worker } from "tesseract.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { isScanEngineHost } from "@/lib/sanita/scan-engine-url";
import { detectPolicyCandidate } from "@/lib/sanita/detector";

const execFileAsync = promisify(execFile);

const OCR_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(OCR_DIR, "../../..");
const TESS_CACHE = path.join(PROJECT_ROOT, ".tesseract-cache");

export type OcrStatus =
  | "OCR_SUCCESS"
  | "OCR_NOT_NEEDED"
  | "OCR_RENDERER_MISSING"
  | "OCR_TIMEOUT"
  | "OCR_EXTRACTION_FAILED"
  | "OCR_EMPTY"
  | "OCR_LOW_CONFIDENCE";

export type RasterizeStatus = "OK" | "RENDERER_MISSING" | "FAILED" | "EMPTY";

export type RasterizeResult = {
  status: RasterizeStatus;
  rendererPath: string | null;
  rendererVersion: string | null;
  pageCount: number;
  images: Buffer[];
  error: string | null;
  durationMs: number;
};

export type ExtractPdfFullTextResult = {
  digital: string;
  ocr: string | null;
  text: string;
  status: OcrStatus;
  reasonCode: OcrStatus;
  rasterize: RasterizeResult | null;
};

export type OcrPdfTextResult = {
  text: string | null;
  status: OcrStatus;
  reasonCode: OcrStatus;
  rasterize: RasterizeResult | null;
};

function tessdataLangPath(): string {
  if (fs.existsSync(path.join(TESS_CACHE, "ita.traineddata"))) return TESS_CACHE;
  return "https://tessdata.projectnaptha.com/4.0.0";
}

const POLICY_EXHAUSTIVE =
  process.env.POLICY_EXHAUSTIVE !== "0" && process.env.POLICY_EXHAUSTIVE !== "false";

/** Pagine massime OCR per PDF. OCR_MAX_PAGES env vince. */
export const MAX_OCR_PAGES = (() => {
  const raw = process.env.OCR_MAX_PAGES;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return Math.min(n, 48);
  }
  if (POLICY_EXHAUSTIVE) return 12;
  if (process.env.SCAN_FAST === "0" || process.env.SCAN_FAST === "false") return 8;
  return 4;
})();

const MIN_IMAGE_BYTES = 12_000;
const MAX_IMAGE_BYTES = 30_000_000;
// A4 a 300 DPI e circa 8,7 MP. Oltre questa soglia il dettaglio aggiuntivo
// non migliora il testo assicurativo, mentre Leptonica puo fallire pixdata_malloc
// e lasciare il crawler apparentemente fermo. Manteniamo margine senza ridurre
// le normali scansioni di documenti.
const MAX_OCR_IMAGE_DIMENSION = 3_600;
const MAX_OCR_IMAGE_PIXELS = 12_000_000;
const DIGITAL_TEXT_RICH_THRESHOLD = 1_500;
function normalizeOcrInsuranceText(text: string): string {
  return text
    .replace(/UNI\s*po[:.\s]*/gi, "UnipolSai ")
    .replace(/UNI\s*POL\s*SAI/gi, "UnipolSai ")
    .replace(/G\s*E\s*N\s*E\s*R\s*A\s*L\s*I/gi, "Generali ")
    .replace(/Z\s*U\s*R\s*I\s*C\s*H/gi, "Zurich ")
    .replace(/NUMERO\s*POLIZZA/gi, "numero polizza ")
    .replace(/SCADENZA\s*POLIZZA/gi, "scadenza polizza ")
    .replace(/RESPONSABILIT[ÀA]\s*CIVILE/gi, "responsabilità civile ")
    .replace(/\s+/g, " ")
    .trim();
}

function isDigitalPlaceholderOnly(digital: string): boolean {
  const stripped = digital.replace(/--\s*\d+\s+of\s+\d+\s*--/gi, "").replace(/\s+/g, " ").trim();
  return stripped.length < 80;
}

/** Coda globale: un solo OCR alla volta (Tesseract non è thread-safe). */
let ocrChain: Promise<unknown> = Promise.resolve();

function enqueueOcr<T>(fn: () => Promise<T>): Promise<T> {
  const run = ocrChain.then(fn, fn);
  ocrChain = run.catch(() => {});
  return run;
}

function ocrJobTimeoutMs(): number {
  const raw = process.env.OCR_JOB_TIMEOUT_MS;
  if (raw === "0" || raw === "false") return 0;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return isScanEngineHost() ? 600_000 : 0;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

export function isOcrEnabled(): boolean {
  return process.env.OCR_ENABLED !== "0" && process.env.OCR_ENABLED !== "false";
}

export function isOcrTechnicalFailure(status: OcrStatus): boolean {
  return (
    status === "OCR_RENDERER_MISSING" ||
    status === "OCR_TIMEOUT" ||
    status === "OCR_EXTRACTION_FAILED"
  );
}

/** Resolve pdftoppm candidates (sync list only — probe is async). */
export function listPdftoppmCandidates(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string | null | undefined) => {
    const v = (p || "").trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };

  // Test escape hatch: force missing without system fallbacks
  if (process.env.PDFTOPPM_DISABLE_SYSTEM_FALLBACK === "1") {
    push(process.env.PDFTOPPM_PATH);
    return out;
  }

  push(process.env.PDFTOPPM_PATH);
  if (process.platform !== "win32") {
    push("/usr/bin/pdftoppm");
    push("/bin/pdftoppm");
  }
  push("pdftoppm");

  // Staging Windows poppler extract
  push(
    path.join(PROJECT_ROOT, "data/staging/poppler/poppler-24.08.0/Library/bin/pdftoppm.exe")
  );
  push(path.join(PROJECT_ROOT, "data/staging/poppler/Library/bin/pdftoppm.exe"));
  return out;
}

/** @deprecated use listPdftoppmCandidates + resolvePdftoppm — kept for callers */
export function resolvePdftoppmPath(): string | null {
  const c = listPdftoppmCandidates();
  for (const bin of c) {
    if (bin.includes("/") || bin.includes("\\")) {
      if (fs.existsSync(bin)) return bin;
      continue;
    }
  }
  // bare name — defer to async probe
  return c.find((x) => !x.includes("/") && !x.includes("\\")) || null;
}

type PdftoppmCache = {
  path: string | null;
  version: string | null;
  probedAt: number;
  ok: boolean;
  diagnostics: string[];
};

const NEGATIVE_CACHE_TTL_MS = 30_000;

let cachedPdftoppm: PdftoppmCache | null = null;

/** Clear resolver cache (preflight / after OCR_RENDERER_MISSING / tests). */
export function resetPdftoppmCache(): void {
  cachedPdftoppm = null;
}

/** @deprecated alias */
export function resetPdftoppmCacheForTests(): void {
  resetPdftoppmCache();
}

function isExecutableAbsolute(bin: string): boolean {
  try {
    if (!fs.existsSync(bin)) return false;
    fs.accessSync(bin, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function probePdftoppmBinary(bin: string): Promise<{ ok: boolean; version: string | null; error: string | null }> {
  const isAbs = bin.includes("/") || bin.includes("\\") || /^[A-Za-z]:\\/.test(bin);
  if (isAbs && !isExecutableAbsolute(bin)) {
    return { ok: false, version: null, error: `not_executable_or_missing:${bin}` };
  }
  try {
    const { stderr, stdout } = await execFileAsync(bin, ["-v"], {
      timeout: 5_000,
      windowsHide: true,
      env: process.env,
    });
    const blob = `${stdout || ""}${stderr || ""}`;
    const m = blob.match(/pdftoppm version[^\r\n]*/i);
    const version =
      (m?.[0] || blob.split(/\r?\n/).find((l) => /pdftoppm/i.test(l)) || blob.trim().split(/\r?\n/)[0] || "").trim() ||
      null;
    return { ok: true, version, error: null };
  } catch (e: unknown) {
    const err = e as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
    const blob = `${err.stdout?.toString?.() ?? err.stdout ?? ""}${err.stderr?.toString?.() ?? err.stderr ?? ""}${err.message ?? ""}`;
    // poppler often exits non-zero on -v while still printing version
    if (/pdftoppm version/i.test(blob)) {
      const m = blob.match(/pdftoppm version[^\r\n]*/i);
      return {
        ok: true,
        version: (m?.[0] || "").trim() || null,
        error: null,
      };
    }
    return { ok: false, version: null, error: blob.slice(0, 240) || "exec_failed" };
  }
}

export async function resolvePdftoppm(): Promise<{
  path: string | null;
  version: string | null;
  diagnostics?: string[];
}> {
  const now = Date.now();
  if (cachedPdftoppm) {
    if (cachedPdftoppm.ok) {
      return { path: cachedPdftoppm.path, version: cachedPdftoppm.version, diagnostics: cachedPdftoppm.diagnostics };
    }
    // negative cache with TTL — never permanent
    if (now - cachedPdftoppm.probedAt < NEGATIVE_CACHE_TTL_MS) {
      return { path: null, version: null, diagnostics: cachedPdftoppm.diagnostics };
    }
  }

  const diagnostics: string[] = [];
  const candidates = listPdftoppmCandidates();
  for (const bin of candidates) {
    const probed = await probePdftoppmBinary(bin);
    if (probed.ok) {
      cachedPdftoppm = {
        path: bin,
        version: probed.version,
        probedAt: now,
        ok: true,
        diagnostics: [...diagnostics, `ok:${bin}`],
      };
      return { path: bin, version: probed.version, diagnostics: cachedPdftoppm.diagnostics };
    }
    diagnostics.push(`fail:${bin}:${probed.error}`);
  }

  cachedPdftoppm = {
    path: null,
    version: null,
    probedAt: now,
    ok: false,
    diagnostics,
  };
  return { path: null, version: null, diagnostics };
}

function extractImagesFromPdfCarving(buffer: Buffer): Buffer[] {
  const images: Buffer[] = [];
  let pos = 0;
  while (true) {
    const start = buffer.indexOf(Buffer.from([0xff, 0xd8, 0xff]), pos);
    if (start === -1) break;
    const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), start);
    if (end === -1) break;
    const img = buffer.slice(start, end + 2);
    if (img.length >= MIN_IMAGE_BYTES && img.length < MAX_IMAGE_BYTES) images.push(img);
    pos = end + 2;
  }
  pos = 0;
  while (true) {
    const start = buffer.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]), pos);
    if (start === -1) break;
    const end = buffer.indexOf(
      Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
      start
    );
    if (end === -1) break;
    const img = buffer.slice(start, end + 8);
    if (img.length >= MIN_IMAGE_BYTES && img.length < MAX_IMAGE_BYTES) images.push(img);
    pos = end + 8;
  }
  return images;
}

async function normalizeEncodedForOcr(buf: Buffer): Promise<Buffer | null> {
  try {
    const img = sharp(buf, { failOn: "none", unlimited: true });
    const meta = await img.metadata();
    if (!meta.width || !meta.height) return null;
    if (meta.width < 32 || meta.height < 32) return null;
    let p = img.flatten({ background: "#ffffff" }).grayscale().normalize();
    const target = boundedOcrDimensions(meta.width, meta.height);
    if (target.width !== meta.width || target.height !== meta.height) {
      p = p.resize({
        width: target.width,
        height: target.height,
        fit: "fill",
        withoutEnlargement: false,
      });
    }
    return await p.png().toBuffer();
  } catch {
    return null;
  }
}

async function normalizeRawForOcr(
  data: Buffer,
  width: number,
  height: number
): Promise<Buffer | null> {
  if (!width || !height || width < 32 || height < 32) return null;
  const channels = Math.round(data.length / (width * height));
  if (channels !== 1 && channels !== 3 && channels !== 4) return null;
  try {
    let p = sharp(data, { raw: { width, height, channels: channels as 1 | 3 | 4 } })
      .flatten({ background: "#ffffff" })
      .grayscale()
      .normalize();
    const target = boundedOcrDimensions(width, height);
    if (target.width !== width || target.height !== height) {
      p = p.resize({
        width: target.width,
        height: target.height,
        fit: "fill",
        withoutEnlargement: false,
      });
    }
    return await p.png().toBuffer();
  } catch {
    return null;
  }
}

/**
 * Rasterize PDF pages via pdftoppm. Never silently returns empty on missing renderer.
 */
export async function rasterizePdfPages(
  pdfBuffer: Buffer,
  maxPages: number,
  startPage = 1
): Promise<RasterizeResult> {
  const t0 = Date.now();
  const resolved = await resolvePdftoppm();
  if (!resolved.path) {
    return {
      status: "RENDERER_MISSING",
      rendererPath: null,
      rendererVersion: null,
      pageCount: 0,
      images: [],
      error: "OCR_RENDERER_MISSING: pdftoppm not found (set PDFTOPPM_PATH or install poppler-utils)",
      durationMs: Date.now() - t0,
    };
  }

  let dir: string | null = null;
  try {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ocrpdf-"));
    const inPath = path.join(dir, "in.pdf");
    const outPrefix = path.join(dir, "page");
    await fs.promises.writeFile(inPath, pdfBuffer);
    await execFileAsync(
      resolved.path,
      [
        "-png",
        "-r",
        "300",
        "-f",
        String(Math.max(1, startPage)),
        "-l",
        String(Math.max(1, startPage) + maxPages - 1),
        "-gray",
        inPath,
        outPrefix,
      ],
      { timeout: 120_000, windowsHide: true }
    );
    const files = (await fs.promises.readdir(dir))
      .filter((f) => f.startsWith("page") && f.endsWith(".png"))
      .sort();
    const buffers: Buffer[] = [];
    for (const f of files.slice(0, maxPages)) {
      buffers.push(await fs.promises.readFile(path.join(dir!, f)));
    }
    if (buffers.length === 0) {
      return {
        status: "EMPTY",
        rendererPath: resolved.path,
        rendererVersion: resolved.version,
        pageCount: 0,
        images: [],
        error: "pdftoppm produced zero pages",
        durationMs: Date.now() - t0,
      };
    }
    return {
      status: "OK",
      rendererPath: resolved.path,
      rendererVersion: resolved.version,
      pageCount: buffers.length,
      images: buffers,
      error: null,
      durationMs: Date.now() - t0,
    };
  } catch (e) {
    return {
      status: "FAILED",
      rendererPath: resolved.path,
      rendererVersion: resolved.version,
      pageCount: 0,
      images: [],
      error: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - t0,
    };
  } finally {
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function extractImagesViaPdfParse(pdfBuffer: Buffer, maxPages: number): Promise<Buffer[]> {
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: pdfBuffer });
    try {
      const info = (await parser.getInfo()) as unknown as {
        total?: number;
        pages?: number;
        numpages?: number;
      };
      const total = Number(info?.total ?? info?.numpages ?? info?.pages ?? maxPages);
      const count = Math.min(maxPages, Math.max(1, total));
      const partial = Array.from({ length: count }, (_, i) => i + 1);
      const result = await parser.getImage({ partial });
      const blobs: Buffer[] = [];
      for (const page of result?.pages ?? []) {
        const pageAny = page as unknown as {
          images?: Array<{ data?: Buffer | Uint8Array; width?: number; height?: number }>;
        };
        for (const im of pageAny.images ?? []) {
          if (!im.data) continue;
          const dataBuf = Buffer.isBuffer(im.data) ? im.data : Buffer.from(im.data);
          if (im.width && im.height) {
            const png = await normalizeRawForOcr(dataBuf, im.width, im.height);
            if (png) blobs.push(png);
          } else {
            const png = await normalizeEncodedForOcr(dataBuf);
            if (png) blobs.push(png);
          }
        }
      }
      return blobs.slice(0, maxPages);
    } finally {
      await parser.destroy().catch(() => {});
    }
  } catch {
    return [];
  }
}

function boundedOcrDimensions(
  width: number,
  height: number
): { width: number; height: number } {
  let scale = Math.min(
    1,
    MAX_OCR_IMAGE_DIMENSION / width,
    MAX_OCR_IMAGE_DIMENSION / height,
    Math.sqrt(MAX_OCR_IMAGE_PIXELS / (width * height))
  );
  if (width < 1_000 && scale === 1) {
    scale = Math.min(
      2,
      2_200 / width,
      MAX_OCR_IMAGE_DIMENSION / height,
      Math.sqrt(MAX_OCR_IMAGE_PIXELS / (width * height))
    );
  }
  return {
    width: Math.max(32, Math.round(width * scale)),
    height: Math.max(32, Math.round(height * scale)),
  };
}

async function readPdfPageCount(pdfBuffer: Buffer): Promise<number | null> {
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: pdfBuffer });
    try {
      const info = (await parser.getInfo()) as unknown as {
        total?: number;
        pages?: number;
        numpages?: number;
      };
      const total = Number(info?.total ?? info?.numpages ?? info?.pages);
      return Number.isFinite(total) && total > 0 ? Math.floor(total) : null;
    } finally {
      await parser.destroy().catch(() => {});
    }
  } catch {
    return null;
  }
}

function exhaustivePdfOcrPageLimit(): number {
  const raw = process.env.OCR_MAX_PAGES;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, 500);
  }
  return POLICY_EXHAUSTIVE ? 500 : MAX_OCR_PAGES;
}

function dedupeImages(buffers: Buffer[]): Buffer[] {
  const seen = new Set<string>();
  const out: Buffer[] = [];
  for (const buf of buffers) {
    const key = `${buf.length}:${buf.subarray(0, 12).toString("hex")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(buf);
  }
  return out;
}

/**
 * Collect OCR images. For scanned PDFs, poppler is required — no silent carve fallback
 * that pretends success with garbage.
 */
export async function collectPdfImagesForOcr(
  pdfBuffer: Buffer,
  opts?: { allowCarveFallback?: boolean }
): Promise<{ images: Buffer[]; rasterize: RasterizeResult }> {
  let rasterize = await rasterizePdfPages(pdfBuffer, MAX_OCR_PAGES);
  if (rasterize.status === "RENDERER_MISSING") {
    // One forced re-probe after clearing negative cache (env may have been fixed mid-process)
    resetPdftoppmCache();
    rasterize = await rasterizePdfPages(pdfBuffer, MAX_OCR_PAGES);
  }
  if (rasterize.status === "OK" && rasterize.images.length > 0) {
    const cleaned: Buffer[] = [];
    for (const png of rasterize.images) {
      cleaned.push((await normalizeEncodedForOcr(png)) ?? png);
    }
    return { images: cleaned.slice(0, MAX_OCR_PAGES), rasterize };
  }
  // Carve fallback only when explicitly allowed (legacy / digital-rich paths) — NOT for scanned fail-closed.
  if (opts?.allowCarveFallback) {
    const carvedClean: Buffer[] = [];
    for (const carved of extractImagesFromPdfCarving(pdfBuffer)) {
      const png = await normalizeEncodedForOcr(carved);
      if (png) carvedClean.push(png);
    }
    const embedded = await extractImagesViaPdfParse(pdfBuffer, MAX_OCR_PAGES);
    return {
      images: dedupeImages([...carvedClean, ...embedded]).slice(0, MAX_OCR_PAGES),
      rasterize,
    };
  }
  return { images: [], rasterize };
}

let ocrHandlersInstalled = false;

export function installOcrSafetyHandlers(): void {
  if (ocrHandlersInstalled) return;
  ocrHandlersInstalled = true;
  const swallow = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      /tesseract|traineddata|fetch failed|read image|special-words|too small to scale|image too small|leptonica|pix.*scale/i.test(
        msg
      )
    ) {
      console.warn(`  [OCR] ${msg.slice(0, 100)}`);
      return true;
    }
    return false;
  };
  process.on("uncaughtException", (err) => {
    if (swallow(err)) return;
    throw err;
  });
  process.on("unhandledRejection", (reason) => {
    if (swallow(reason)) return;
  });
}

async function createIsolatedWorker(): Promise<Worker | null> {
  installOcrSafetyHandlers();
  if (!process.env.TESSDATA_PREFIX && fs.existsSync(TESS_CACHE)) {
    process.env.TESSDATA_PREFIX = TESS_CACHE;
  }
  const prevCwd = process.cwd();
  if (fs.existsSync(TESS_CACHE)) {
    try {
      process.chdir(TESS_CACHE);
    } catch {
      /* ignore */
    }
  }
  const baseOpts = {
    logger: () => {},
    cachePath: TESS_CACHE,
    langPath: tessdataLangPath(),
    errorHandler: () => {},
  };

  for (const lang of ["ita+eng", "ita", "eng"] as const) {
    try {
      const w = await createWorker(lang, 1, baseOpts);
      if (fs.existsSync(TESS_CACHE)) {
        try {
          process.chdir(prevCwd);
        } catch {
          /* ignore */
        }
      }
      return w;
    } catch {
      /* next lang */
    }
  }
  try {
    process.chdir(prevCwd);
  } catch {
    /* ignore */
  }
  return null;
}

async function recognizeImage(img: Buffer, worker: Worker): Promise<string> {
  try {
    const safe = (await normalizeEncodedForOcr(img)) ?? img;
    const meta = await sharp(safe, { failOn: "none" }).metadata();
    if (!meta.width || !meta.height || meta.width < 32 || meta.height < 32) return "";
    const {
      data: { text },
    } = await worker.recognize(safe);
    return text ?? "";
  } catch {
    return "";
  }
}

async function runOcrOnImages(
  images: Buffer[]
): Promise<{ text: string | null; status: OcrStatus }> {
  if (images.length === 0) return { text: null, status: "OCR_EMPTY" };
  const worker = await createIsolatedWorker();
  if (!worker) return { text: null, status: "OCR_EXTRACTION_FAILED" };

  const maxPages = Math.max(1, MAX_OCR_PAGES);
  const slice = images.slice(0, maxPages);
  try {
    let combined = "";
    let emptyStreak = 0;
    let timedOut = false;
    const t0 = Date.now();
    const hardMs = ocrJobTimeoutMs();
    for (const img of slice) {
      const remainingMs = hardMs > 0 ? hardMs - (Date.now() - t0) : 0;
      if (hardMs > 0 && remainingMs <= 0) {
        timedOut = true;
        break;
      }
      let text = "";
      try {
        text =
          hardMs > 0
            ? await withTimeout(
                recognizeImage(img, worker),
                remainingMs,
                "OCR recognize"
              )
            : await recognizeImage(img, worker);
      } catch (error) {
        if (/OCR recognize timeout/i.test(String(error))) {
          timedOut = true;
          break;
        }
        continue;
      }
      if (!text.trim()) {
        emptyStreak++;
        if (emptyStreak >= 6 && !combined.trim()) break;
        continue;
      }
      emptyStreak = 0;
      combined += text + "\n";
      const candidateText = normalizeOcrInsuranceText(
        combined.replace(/\s+/g, " ").trim()
      );
      if (
        candidateText.length > 400 &&
        detectPolicyCandidate(candidateText).candidate
      ) {
        break;
      }
    }
    const normalized = normalizeOcrInsuranceText(combined.replace(/\s+/g, " ").trim());
    if (timedOut && normalized && detectPolicyCandidate(normalized).candidate) {
      return {
        text: normalized,
        status: "OCR_SUCCESS",
      };
    }
    if (timedOut) {
      return {
        text: normalized || null,
        status: "OCR_TIMEOUT",
      };
    }
    if (!normalized) return { text: null, status: "OCR_EMPTY" };
    // Low confidence: mostly symbols / very short alpha ratio
    const alpha = (normalized.match(/[A-Za-zÀ-ú0-9]/g) || []).length;
    if (alpha < 40 || alpha / Math.max(normalized.length, 1) < 0.25) {
      return { text: normalized, status: "OCR_LOW_CONFIDENCE" };
    }
    return { text: normalized, status: "OCR_SUCCESS" };
  } finally {
    await worker.terminate().catch(() => {});
  }
}

/** OCR a standalone image discovered on a first-party site. */
export async function extractImageText(
  imageBuffer: Buffer
): Promise<{ text: string | null; status: OcrStatus }> {
  if (!isOcrEnabled()) return { text: null, status: "OCR_EXTRACTION_FAILED" };
  return enqueueOcr(() => runOcrOnImages([imageBuffer]));
}

export type ImageVisualAnalysis = {
  stronglyPhotographic: boolean;
  clearlyNonDocumentMedia: boolean;
  width: number;
  height: number;
  entropy: number;
  sharpness: number;
  meanBrightness: number;
  colorMeanSpread: number;
  alphaMean: number | null;
};

/**
 * Conservative post-OCR media classifier. A high-entropy, globally soft,
 * non-white raster is characteristic of a photograph, unlike a scanned page
 * whose background dominates and whose text creates sharp edges.
 */
export async function analyzeImageVisualContent(
  imageBuffer: Buffer
): Promise<ImageVisualAnalysis | null> {
  try {
    const image = sharp(imageBuffer, { failOn: "none", unlimited: true });
    const [metadata, stats] = await Promise.all([image.metadata(), image.stats()]);
    const width = Number(metadata.width || 0);
    const height = Number(metadata.height || 0);
    const rgb = stats.channels.slice(0, 3);
    if (!width || !height || rgb.length < 3) return null;
    const means = rgb.map((channel) => channel.mean);
    const meanBrightness = means.reduce((sum, value) => sum + value, 0) / 3;
    const colorMeanSpread = Math.max(...means) - Math.min(...means);
    const alphaMean = stats.channels.length > 3
      ? Number(stats.channels[3]?.mean ?? 255)
      : null;
    const entropy = Number(stats.entropy || 0);
    const sharpness = Number(stats.sharpness || 0);
    const aspect = width / height;
    const largeNaturalPhoto =
      Math.max(width, height) >= 600 &&
      entropy >= 6 &&
      sharpness <= 4.5 &&
      meanBrightness < 210;
    const smallPhotoCollage =
      Math.max(width, height) <= 800 &&
      aspect >= 0.5 &&
      aspect <= 2 &&
      entropy >= 4.8 &&
      colorMeanSpread >= 12 &&
      meanBrightness < 235;
    const brightPortraitPhoto =
      Math.max(width, height) >= 500 &&
      aspect >= 0.5 &&
      aspect <= 2 &&
      entropy >= 4 &&
      sharpness <= 3 &&
      meanBrightness < 240;
    const smallNeutralPhoto =
      Math.max(width, height) >= 400 &&
      Math.min(width, height) >= 200 &&
      aspect >= 0.5 &&
      aspect <= 2.3 &&
      entropy >= 6.5 &&
      sharpness <= 3.2 &&
      meanBrightness < 215;
    const wideMarketingGraphic =
      aspect >= 1.55 &&
      Math.max(width, height) >= 600 &&
      entropy >= 4 &&
      sharpness <= 5 &&
      meanBrightness < 200;
    const wideBrandBanner =
      aspect >= 3 &&
      Math.max(width, height) >= 600 &&
      entropy < 3 &&
      sharpness <= 3;
    const wideBrightBrandGraphic =
      aspect >= 1.8 &&
      Math.max(width, height) >= 600 &&
      entropy < 3 &&
      sharpness <= 3.5 &&
      meanBrightness >= 210;
    const smallUiGraphic =
      Math.max(width, height) <= 384 && width * height <= 120_000;
    const transparentCutout =
      alphaMean !== null &&
      alphaMean < 245 &&
      Math.max(width, height) >= 300 &&
      aspect >= 0.4 &&
      aspect <= 2.5 &&
      entropy >= 3;
    const transparentUiGraphic =
      alphaMean !== null &&
      alphaMean < 200 &&
      Math.max(width, height) <= 512 &&
      width * height <= 200_000;
    const stronglyPhotographic =
      largeNaturalPhoto ||
      smallPhotoCollage ||
      brightPortraitPhoto ||
      smallNeutralPhoto ||
      wideMarketingGraphic;
    return {
      stronglyPhotographic,
      clearlyNonDocumentMedia:
        stronglyPhotographic ||
        wideBrandBanner ||
        wideBrightBrandGraphic ||
        smallUiGraphic ||
        transparentCutout ||
        transparentUiGraphic,
      width,
      height,
      entropy,
      sharpness,
      meanBrightness,
      colorMeanSpread,
      alphaMean,
    };
  } catch {
    return null;
  }
}

export async function ocrPdfText(
  pdfBuffer: Buffer,
  opts?: { pageNumbers?: number[] }
): Promise<OcrPdfTextResult> {
  if (!isOcrEnabled()) {
    return {
      text: null,
      status: "OCR_NOT_NEEDED",
      reasonCode: "OCR_NOT_NEEDED",
      rasterize: null,
    };
  }

  return enqueueOcr(async () => {
    const ms = ocrJobTimeoutMs();
    const job = (async (): Promise<OcrPdfTextResult> => {
      const totalPages = await readPdfPageCount(pdfBuffer);
      if (!totalPages) {
        return {
          text: null,
          status: "OCR_EXTRACTION_FAILED",
          reasonCode: "OCR_EXTRACTION_FAILED",
          rasterize: {
            status: "FAILED",
            rendererPath: null,
            rendererVersion: null,
            pageCount: 0,
            images: [],
            error: "OCR_PAGE_COUNT_UNKNOWN",
            durationMs: 0,
          },
        };
      }
      const pageLimit = exhaustivePdfOcrPageLimit();
      const requestedPages =
        opts?.pageNumbers && opts.pageNumbers.length > 0
          ? [
              ...new Set(
                opts.pageNumbers
                  .map((page) => Math.floor(Number(page)))
                  .filter((page) => page >= 1 && page <= totalPages)
              ),
            ].sort((a, b) => a - b)
          : Array.from({ length: totalPages }, (_, index) => index + 1);
      const targetPages = requestedPages.slice(0, pageLimit);
      const pageBatches: Array<{ startPage: number; size: number }> = [];
      for (const page of targetPages) {
        const last = pageBatches.at(-1);
        if (
          last &&
          last.startPage + last.size === page &&
          last.size < MAX_OCR_PAGES
        ) {
          last.size++;
        } else {
          pageBatches.push({ startPage: page, size: 1 });
        }
      }
      let combined = "";
      let pagesRead = 0;
      let sawLowConfidence = false;
      let aggregateRasterize: RasterizeResult | null = null;

      for (const { startPage, size: batchSize } of pageBatches) {
        let rasterize = await rasterizePdfPages(pdfBuffer, batchSize, startPage);
        if (rasterize.status === "RENDERER_MISSING") {
          resetPdftoppmCache();
          rasterize = await rasterizePdfPages(pdfBuffer, batchSize, startPage);
        }
        aggregateRasterize = {
          ...rasterize,
          pageCount: pagesRead + rasterize.pageCount,
          images: [],
        };
        if (rasterize.status === "RENDERER_MISSING") {
          return {
            text: combined || null,
            status: "OCR_RENDERER_MISSING",
            reasonCode: "OCR_RENDERER_MISSING",
            rasterize: aggregateRasterize,
          };
        }
        if (rasterize.status === "FAILED") {
          return {
            text: combined || null,
            status: "OCR_EXTRACTION_FAILED",
            reasonCode: "OCR_EXTRACTION_FAILED",
            rasterize: aggregateRasterize,
          };
        }
        if (rasterize.images.length === 0) {
          return {
            text: combined || null,
            status: "OCR_EMPTY",
            reasonCode: "OCR_EMPTY",
            rasterize: aggregateRasterize,
          };
        }
        const cleaned: Buffer[] = [];
        for (const png of rasterize.images) {
          cleaned.push((await normalizeEncodedForOcr(png)) ?? png);
        }
        const batch = await runOcrOnImages(cleaned);
        pagesRead += rasterize.pageCount;
        aggregateRasterize.pageCount = pagesRead;
        if (batch.text) combined = `${combined} ${batch.text}`.trim();
        if (batch.status === "OCR_TIMEOUT" || batch.status === "OCR_EXTRACTION_FAILED") {
          return {
            text: combined || null,
            status: batch.status,
            reasonCode: batch.status,
            rasterize: aggregateRasterize,
          };
        }
        if (batch.status === "OCR_LOW_CONFIDENCE") sawLowConfidence = true;
        const normalized = normalizeOcrInsuranceText(combined);
        if (normalized && detectPolicyCandidate(normalized).candidate) {
          return {
            text: normalized,
            status: "OCR_SUCCESS",
            reasonCode: "OCR_SUCCESS",
            rasterize: aggregateRasterize,
          };
        }
      }

      const normalized = normalizeOcrInsuranceText(combined);
      if (requestedPages.length > pageLimit) {
        return {
          text: normalized || null,
          status: "OCR_EXTRACTION_FAILED",
          reasonCode: "OCR_EXTRACTION_FAILED",
          rasterize: aggregateRasterize
            ? {
                ...aggregateRasterize,
                status: "FAILED",
                error: `OCR_PAGE_LIMIT:${pagesRead}/${requestedPages.length}`,
              }
            : null,
        };
      }
      const status: OcrStatus = !normalized
        ? "OCR_EMPTY"
        : sawLowConfidence
          ? "OCR_LOW_CONFIDENCE"
          : "OCR_SUCCESS";
      return {
        text: normalized || null,
        status,
        reasonCode: status,
        rasterize: aggregateRasterize,
      };
    })();

    // Il timeout è applicato dentro runOcrOnImages alla singola recognize:
    // il finally termina Tesseract prima che la coda inizi il job seguente.
    // Un Promise.race qui lascerebbe il job sconfitto vivo in background.
    void ms;
    return job;
  });
}

/** @deprecated Prefer extractPdfFullText — kept for callers that expect string|null. */
export async function ocrPdfTextLegacy(pdfBuffer: Buffer): Promise<string | null> {
  const r = await ocrPdfText(pdfBuffer);
  return r.text;
}

export async function extractPdfFullText(pdfBuffer: Buffer): Promise<ExtractPdfFullTextResult> {
  let digital = "";
  let digitalPages: Array<{ num: number; text: string }> = [];
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: pdfBuffer });
    try {
      const result = await parser.getText();
      digital = (result?.text || "").replace(/\s+/g, " ").trim();
      digitalPages = (result?.pages || []).map((page) => ({
        num: Number(page.num),
        text: String(page.text || ""),
      }));
    } finally {
      await parser.destroy().catch(() => {});
    }
  } catch {
    digital = "";
    digitalPages = [];
  }

  // Strip pdf-parse page markers like "-- 1 of 38 --" for richness check
  const digitalMeaningful = digital
    .replace(/--\s*\d+\s+of\s+\d+\s*--/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  const thinDigitalPages = digitalPages
    .filter((page) => {
      const meaningful = page.text
        .replace(/--\s*\d+\s+of\s+\d+\s*--/gi, "")
        .replace(/\s+/g, " ")
        .trim();
      return Number.isFinite(page.num) && page.num > 0 && meaningful.length < 80;
    })
    .map((page) => page.num);

  if (
    digitalMeaningful.length >= DIGITAL_TEXT_RICH_THRESHOLD &&
    thinDigitalPages.length === 0
  ) {
    return {
      digital,
      ocr: null,
      text: digital,
      status: "OCR_NOT_NEEDED",
      reasonCode: "OCR_NOT_NEEDED",
      rasterize: null,
    };
  }

  if (!isOcrEnabled() && digitalMeaningful.length > 80) {
    // OCR intentionally off and digital text is usable — never claim RENDERER_MISSING.
    return {
      digital,
      ocr: null,
      text: digital,
      status: "OCR_NOT_NEEDED",
      reasonCode: "OCR_NOT_NEEDED",
      rasterize: null,
    };
  }
  // Fail-closed: thin/scanned digital always attempts OCR even if a caller set OCR_ENABLED=0
  // (e.g. non-policyish URL gate). OCR_RENDERER_MISSING must mean pdftoppm really missing.
  // ocrPdfText() itself respects OCR_ENABLED — force-enable for this thin-digital path only.
  const prevOcrEnabled = process.env.OCR_ENABLED;
  process.env.OCR_ENABLED = "1";
  let ocrResult;
  try {
    ocrResult = await ocrPdfText(
      pdfBuffer,
      thinDigitalPages.length > 0 ? { pageNumbers: thinDigitalPages } : undefined
    );
  } finally {
    if (prevOcrEnabled == null) delete process.env.OCR_ENABLED;
    else process.env.OCR_ENABLED = prevOcrEnabled;
  }
  const policyHint = /polizz|assicuraz|gelli|responsabilit|massimale|rc\b|unipol|184419/i;

  let text = digital;
  const ocrText = ocrResult.text ? normalizeOcrInsuranceText(ocrResult.text) : null;
  if (ocrText) {
    const digitalThin = isDigitalPlaceholderOnly(digital) || digitalMeaningful.length < 200;
    const merged = digitalThin
      ? ocrText
      : `${digital} ${ocrText}`.replace(/\s+/g, " ").trim();
    if (
      merged.length > digital.length ||
      digitalMeaningful.length < 200 ||
      (policyHint.test(ocrText) && !policyHint.test(digital))
    ) {
      text = merged;
    }
  }

  // Propagate technical statuses — never pretend empty digital = commercial "no policy"
  if (isOcrTechnicalFailure(ocrResult.status) || ocrResult.status === "OCR_EMPTY") {
    return {
      digital,
      ocr: ocrResult.text,
      text: text || digital || ocrResult.text || "",
      status: ocrResult.status,
      reasonCode: ocrResult.reasonCode,
      rasterize: ocrResult.rasterize,
    };
  }

  if (ocrResult.status === "OCR_LOW_CONFIDENCE") {
    return {
      digital,
      ocr: ocrText,
      text: text || digital || ocrText || "",
      status: "OCR_LOW_CONFIDENCE",
      reasonCode: "OCR_LOW_CONFIDENCE",
      rasterize: ocrResult.rasterize,
    };
  }

  return {
    digital,
    ocr: ocrText,
    text: text || digital || ocrText || "",
    status: ocrText ? "OCR_SUCCESS" : "OCR_EMPTY",
    reasonCode: ocrText ? "OCR_SUCCESS" : "OCR_EMPTY",
    rasterize: ocrResult.rasterize,
  };
}

export async function terminateOcrWorker(): Promise<void> {
  /* worker isolati: nulla da terminare globalmente */
}
