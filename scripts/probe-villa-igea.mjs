import { analyzePolicy } from "../src/lib/sanita/detector.ts";
import { externalFetch } from "../src/lib/http.ts";

const url = process.argv[2] ?? "https://www.casadicuravillaigea.it/sito/amministrazione-trasparente";

const res = await externalFetch(url, { timeoutMs: 30000 });
const html = await res.text();
const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

console.log("URL:", url, "status:", res.status, "chars:", text.length);
const slice = text.match(/polizza[\s\S]{0,800}/i)?.[0] ?? text.slice(0, 500);
console.log("\nSnippet:\n", slice);

const a = analyzePolicy(text);
console.log("\nANALYSIS:", JSON.stringify(a, null, 2));
