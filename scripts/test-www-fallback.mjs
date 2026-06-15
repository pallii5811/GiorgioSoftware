import { crawlSite } from "../src/lib/sanita/crawler.ts";

process.env.OCR_ENABLED = "0";
process.env.SCAN_FAST = "1";

const url = process.argv[2] || "https://www.villafioritacapua.it";
console.log(`Crawl: ${url}`);
const r = await crawlSite(url);
console.log("ok:", r.ok, "| error:", r.error);
console.log("foundRelevant:", r.foundRelevantPage, "| pages:", r.pagesVisited.length);
const pdfs = r.pagesVisited.filter((u) => /\.pdf/i.test(u));
console.log("pdf:", pdfs.slice(0, 5).join("\n     "));
console.log("textLen:", r.text.length);
process.exit(r.ok ? 0 : 1);
