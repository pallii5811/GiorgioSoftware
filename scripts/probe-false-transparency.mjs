import * as cheerio from "cheerio";
import { externalFetch } from "../src/lib/http.ts";
import { pageCountsAsPolicyRelevant } from "../src/lib/sanita/crawler.ts";
import { analyzePolicy } from "../src/lib/sanita/detector.ts";

const sites = [
  ["alloggioanziani", "https://www.alloggioanziani.it/"],
  ["medicinafutura", "https://www.medicinafutura.it/"],
  ["emfisioterapia", "https://emfisioterapia.it/"],
  ["centrominerva", "https://centrominerva.org/amministrazione-trasparente/"],
  ["centrodrd", "https://www.centrodrd.it/"],
];

function extractText(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe").remove();
  return $("body").text().replace(/\s+/g, " ").trim();
}

for (const [name, url] of sites) {
  try {
    const res = await externalFetch(url, { timeoutMs: 20000, redirect: "follow" });
    const html = await res.text();
    const text = extractText(html);
    const relevant = pageCountsAsPolicyRelevant(url, text);
    const policy = analyzePolicy(text);
    const match = text.match(/trasparen|assicuraz|polizza|cookie|privacy/gi) || [];
    console.log(`\n=== ${name} === status=${res.status} final=${res.url} chars=${text.length}`);
    console.log("relevant:", relevant, "policyFound:", policy.policyFound);
    console.log("keywords:", [...new Set(match)].slice(0, 8).join(", "));
    console.log("snippet:", text.slice(0, 200));
  } catch (e) {
    console.log(`\n=== ${name} === ERROR: ${e.message}`);
  }
}
