import * as cheerio from "cheerio";
import { externalFetch } from "../src/lib/http.ts";
import { pageCountsAsPolicyRelevant } from "../src/lib/sanita/crawler.ts";
import { analyzePolicy } from "../src/lib/sanita/detector.ts";

const PROBE_PATHS = [
  "/amministrazione-trasparente",
  "/societa-trasparente",
  "/documenti",
  "/trasparenza",
];

function extractText(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe").remove();
  return $("body").text().replace(/\s+/g, " ").trim();
}

const base = process.argv[2] ?? "https://www.alloggioanziani.it/";
for (const path of PROBE_PATHS) {
  const url = new URL(path, base).toString();
  try {
    const res = await externalFetch(url, { timeoutMs: 15000, redirect: "follow" });
    const text = extractText(await res.text());
    const rel = pageCountsAsPolicyRelevant(url, text);
    console.log(path, "->", new URL(res.url).pathname, "relevant:", rel, "policy:", analyzePolicy(text).policyFound, "chars:", text.length);
    if (rel) console.log("  snip:", text.match(/trasparen|polizza|assicuraz|gelli/gi));
  } catch (e) {
    console.log(path, "ERR", e.message);
  }
}
