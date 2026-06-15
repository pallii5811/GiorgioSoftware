import { createWorker, type Worker } from "tesseract.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OCR_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(OCR_DIR, "../../..");
const TESS_CACHE = path.join(PROJECT_ROOT, ".tesseract-cache");

function tessdataLangPath(): string {
  if (fs.existsSync(path.join(TESS_CACHE, "ita.traineddata"))) return TESS_CACHE;
  return "https://tessdata.projectnaptha.com/4.0.0";
}

const POLICY_EXHAUSTIVE =
  process.env.POLICY_EXHAUSTIVE !== "0" && process.env.POLICY_EXHAUSTIVE !== "false";

/** Pagine massime OCR per PDF — esaustivo: tutte le pagine policy (no PDF saltati). */
export const MAX_OCR_PAGES = POLICY_EXHAUSTIVE
  ? 48
  : process.env.SCAN_FAST === "0" || process.env.SCAN_FAST === "false"
    ? 12
    : 4;

const MIN_IMAGE_BYTES = 12_000;
const MAX_IMAGE_BYTES = 30_000_000;

/** Coda globale: un solo OCR alla volta (Tesseract non è thread-safe). */
let ocrChain: Promise<unknown> = Promise.resolve();

function enqueueOcr<T>(fn: () => Promise<T>): Promise<T> {
  const run = ocrChain.then(fn, fn);
  ocrChain = run.catch(() => {});
  return run;
}

export function isOcrEnabled(): boolean {
  return process.env.OCR_ENABLED !== "0" && process.env.OCR_ENABLED !== "false";
}

/** Carving JPEG/PNG dal buffer PDF (scanner tipici). */
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

/** Immagini embedded via pdf-parse (JPEG2000, flate, ecc.). */
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
        for (const img of page.images ?? []) {
          if (!img?.data?.length) continue;
          if (img.width < 120 || img.height < 120) continue;
          blobs.push(Buffer.from(img.data));
        }
      }
      return blobs;
    } finally {
      await parser.destroy().catch(() => {});
    }
  } catch {
    return [];
  }
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

/** Raccoglie tutte le immagini OCR-able da un PDF scannerizzato. */
export async function collectPdfImagesForOcr(pdfBuffer: Buffer): Promise<Buffer[]> {
  const carved = extractImagesFromPdfCarving(pdfBuffer);
  const embedded = await extractImagesViaPdfParse(pdfBuffer, MAX_OCR_PAGES);
  return dedupeImages([...carved, ...embedded]).slice(0, MAX_OCR_PAGES);
}

let ocrHandlersInstalled = false;

/** Evita crash del processo su errori interni del worker Tesseract. */
export function installOcrSafetyHandlers(): void {
  if (ocrHandlersInstalled) return;
  ocrHandlersInstalled = true;
  const swallow = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (/tesseract|traineddata|fetch failed|read image|special-words/i.test(msg)) {
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
  // Evita "failed to load ./ita.special-words" quando il cwd non è la cache tessdata.
  if (!process.env.TESSDATA_PREFIX && fs.existsSync(TESS_CACHE)) {
    process.env.TESSDATA_PREFIX = TESS_CACHE;
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
      return w;
    } catch {
      /* prova lingua successiva */
    }
  }
  return null;
}

/** OCR su buffer immagine singolo — worker dedicato, sempre terminato. */
async function recognizeImage(img: Buffer, worker: Worker): Promise<string> {
  try {
    const {
      data: { text },
    } = await worker.recognize(img);
    return text ?? "";
  } catch {
    return "";
  }
}

/**
 * OCR su PDF scannerizzato — worker isolato per job (no crash cross-batch).
 * @returns testo OCR o null
 */
export async function ocrPdfText(pdfBuffer: Buffer): Promise<string | null> {
  if (!isOcrEnabled()) return null;

  return enqueueOcr(async () => {
    const images = await collectPdfImagesForOcr(pdfBuffer);
    if (images.length === 0) return null;

    const worker = await createIsolatedWorker();
    if (!worker) return null;

    try {
      let combined = "";
      for (const img of images) {
        const text = await recognizeImage(img, worker);
        if (text.trim()) combined += text + "\n";
      }
      const normalized = combined.replace(/\s+/g, " ").trim();
      return normalized || null;
    } finally {
      await worker.terminate().catch(() => {});
    }
  });
}

/**
 * Estrae testo da PDF: digitale (pdf-parse) + OCR scannerizzato (merge).
 * Usato dal crawler per non perdere polizze solo-immagine.
 */
/**
 * Sotto questa soglia il PDF è probabilmente scannerizzato (solo immagini):
 * l'OCR è obbligatorio. Sopra, il testo digitale è già completo e l'OCR
 * non può aggiungere una polizza che non sia già leggibile.
 */
const DIGITAL_TEXT_RICH_THRESHOLD = 1_500;

export async function extractPdfFullText(pdfBuffer: Buffer): Promise<{
  digital: string;
  ocr: string | null;
  text: string;
}> {
  let digital = "";
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: pdfBuffer });
    try {
      const result = await parser.getText();
      digital = (result?.text || "").replace(/\s+/g, " ").trim();
    } finally {
      await parser.destroy().catch(() => {});
    }
  } catch {
    digital = "";
  }

  // OCR solo su PDF scannerizzati: se il testo digitale è ricco, è già tutto leggibile.
  const ocr =
    digital.length >= DIGITAL_TEXT_RICH_THRESHOLD ? null : await ocrPdfText(pdfBuffer);
  const policyHint = /polizz|assicuraz|gelli|responsabilit|massimale|rc\b/i;

  let text = digital;
  if (ocr) {
    const merged = `${digital} ${ocr}`.replace(/\s+/g, " ").trim();
    // Preferisci merge se OCR aggiunge contenuto o se il digitale è scarso
    if (
      merged.length > digital.length ||
      digital.length < 200 ||
      (policyHint.test(ocr) && !policyHint.test(digital))
    ) {
      text = merged;
    }
  }

  return { digital, ocr, text: text || digital || ocr || "" };
}

/** Legacy — chiude eventuali worker (no-op con worker isolati). */
export async function terminateOcrWorker(): Promise<void> {
  /* worker isolati: nulla da terminare globalmente */
}
