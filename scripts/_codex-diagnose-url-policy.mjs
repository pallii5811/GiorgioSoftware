import * as cheerio from "cheerio";
import { analyzePolicy } from "../src/lib/sanita/detector.ts";

const url = process.argv[2];
if (!url) throw new Error("URL required");
const response = await fetch(url);
const html = await response.text();
const text = cheerio.load(html).text().replace(/\s+/g, " ").trim();
const analysis = analyzePolicy(text, url);
const patterns = [
  /\bAXA\b/gi,
  /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g,
  /\b(?:scadenza|polizza|assicur|responsabilit[aà]\s+civile|massimale)\b/gi,
];
const contexts = [];
for (const pattern of patterns) {
  for (const match of text.matchAll(pattern)) {
    contexts.push({
      token: match[0],
      index: match.index,
      context: text.slice(Math.max(0, match.index - 240), match.index + 500),
    });
  }
}
console.log(
  JSON.stringify({
    url,
    status: response.status,
    htmlLength: html.length,
    textLength: text.length,
    analysis,
    contexts: contexts.slice(0, 30),
  })
);
