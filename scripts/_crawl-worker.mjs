/**
 * Worker isolato: un crawl per processo — crash OCR non uccide il batch re-audit.
 * Uso: npx tsx scripts/_crawl-worker.mjs <url>
 */
import { crawlSite } from "../src/lib/sanita/crawler.ts";
import { installOcrSafetyHandlers } from "../src/lib/sanita/ocr.ts";

process.env.OCR_ENABLED = process.env.OCR_ENABLED ?? "1";
process.env.POLICY_EXHAUSTIVE = process.env.POLICY_EXHAUSTIVE ?? "1";
installOcrSafetyHandlers();

const url = process.argv[2];
if (!url) {
  console.error("usage: _crawl-worker.mjs <url>");
  process.exit(2);
}

try {
  const result = await crawlSite(url);
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stdout.write(JSON.stringify({ ok: false, error: msg, crash: true }));
  process.exit(1);
}
