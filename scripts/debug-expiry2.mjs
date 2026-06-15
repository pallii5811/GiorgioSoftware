/** Mostra contesto date/periodo nel corpus polizza di un sito. */
process.env.OCR_ENABLED = "1";
import { crawlSite } from "../src/lib/sanita/crawler.ts";

const url = process.argv[2];
const crawl = await crawlSite(url);
const text = (crawl.policyText || crawl.text || "").replace(/\s+/g, " ");
console.log(`len=${text.length}`);
for (const kw of [/scadenz/gi, /decorrenz/gi, /periodo\s+assicur/gi, /validit/gi, /durata/gi, /effetto/gi]) {
  for (const m of text.matchAll(kw)) {
    const i = m.index ?? 0;
    console.log(`>>> ${text.slice(Math.max(0, i - 60), i + 140)}`);
  }
}
process.exit(0);
