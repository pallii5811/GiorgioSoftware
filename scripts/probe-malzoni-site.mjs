import { externalFetch } from "../src/lib/http.ts";
import { extractPageText } from "../src/lib/sanita/extract-embedded.ts";

const url = "https://www.malzoni.it/societa-trasparente/";
const html = await (await externalFetch(url, { timeoutMs: 45000 })).text();
const pdfs = [...html.matchAll(/href=["']([^"']+\.pdf[^"']*)["']/gi)].map((m) => {
  try {
    return new URL(m[1], url).toString();
  } catch {
    return m[1];
  }
});
console.log("total pdfs in static html:", pdfs.length);
for (const p of pdfs.filter((x) => /pars|parm|assicur|polizz|gelli|rischio|obbligo/i.test(x))) {
  console.log(" ", p);
}
const text = extractPageText(html);
console.log("has autoassicur in html:", /autoassicur|gestione\s+diretta/i.test(text));
console.log("has pars link text:", /risk\s+management|pars/i.test(text));
