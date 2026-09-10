#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { createWorker } from "tesseract.js";

const img = "/tmp/pars6-06.png";
const caches = [
  "/opt/leadsniper-revalidate/app/.tesseract-cache",
  "/opt/leadsniper/.tesseract-cache",
];
let langPath = "https://tessdata.projectnaptha.com/4.0.0_fast";
for (const c of caches) {
  if (fs.existsSync(path.join(c, "eng.traineddata")) || fs.existsSync(path.join(c, "ita.traineddata"))) {
    langPath = c;
    break;
  }
}
const lang = fs.existsSync(path.join(langPath, "ita.traineddata")) ? "ita" : "eng";
console.log({ langPath, lang });
const worker = await createWorker(lang, 1, { langPath });
const { data } = await worker.recognize(img);
await worker.terminate();
const t = data.text || "";
fs.writeFileSync("/tmp/pars6-ocr.txt", t);
console.log(JSON.stringify({
  len: t.length,
  conf: data.confidence,
  hasPhrase: /opera\s+sotto\s+il\s+regime\s+di\s+autoassicurazione/i.test(t),
  hasAuto: /autoassicur/i.test(t),
  snip: t.replace(/\s+/g, " ").slice(0, 800),
}));
