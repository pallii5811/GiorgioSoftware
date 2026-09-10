import assert from "node:assert/strict";

// k3 2026-07-31 — root cause UTAP/Feltre: la regex url(...) case-insensitive
// catturava chiamate JS tipo getDownloadURL(storageRef) / createObjectURL(blob)
// e generava rotte finte (https://utap.it/blob, /storageRef, /file, ...).
// Su SPA che rispondono 200 a ogni path, ogni rotta finta veniva crawldata.

const { discoverResourcesFromText } = await import(
  "../src/lib/sanita/site-resource.ts"
);

const website = "https://utap.it/";
const pageUrl = "https://utap.it/";

const firebaseJs = `
  import { getDownloadURL, ref } from "firebase/storage";
  const storageRef = ref(storage, "docs/relazione.pdf");
  getDownloadURL(storageRef).then((u) => console.log(u));
  const objectURL = URL.createObjectURL(blob);
  const other = createObjectURL(file);
  const seller = resolveURL(seller-nick);
  const full = window.URL(blob2);
`;

const realCss = `
  .a { background: url(/img/logo.png); }
  .b { src: url('fonts/inter.woff2'); }
  .c { background: url("https://utap.it/media/documento-trasparenza.pdf"); }
  .d { background: url(data:image/png;base64,iVBOR); }
`;

const fromJs = discoverResourcesFromText(firebaseJs, pageUrl, website).map((r) => r.url);
const fromCss = discoverResourcesFromText(realCss, pageUrl, website).map((r) => r.url);

for (const fake of [
  "https://utap.it/storageRef",
  "https://utap.it/blob",
  "https://utap.it/file",
  "https://utap.it/seller-nick",
  "https://utap.it/blob2",
]) {
  assert.ok(!fromJs.includes(fake), `fake route ancora estratta: ${fake}`);
}

assert.ok(fromCss.includes("https://utap.it/img/logo.png"), "url(/img/logo.png) perso");
assert.ok(fromCss.includes("https://utap.it/fonts/inter.woff2"), "url(fonts/inter.woff2) perso");
assert.ok(
  fromCss.includes("https://utap.it/media/documento-trasparenza.pdf"),
  "url assoluto PDF perso"
);

console.log("OK url() filter: nessuna rotta finta da identificatori JS, risorse reali preservate");
console.log("js_extracted:", JSON.stringify(fromJs));
console.log("css_extracted:", JSON.stringify(fromCss));
