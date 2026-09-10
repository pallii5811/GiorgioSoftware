#!/usr/bin/env node
import fs from "fs";
import { createWorker } from "tesseract.js";

const imgPath = "/tmp/pars6-06.png";
const cache = "/opt/leadsniper-revalidate/app/.tesseract-cache";
const worker = await createWorker("ita+eng", 1, { langPath: cache });
const { data } = await worker.recognize(imgPath);
await worker.terminate();
const t = data.text || "";
fs.writeFileSync("/tmp/pars6-ocr.txt", t);
console.log(JSON.stringify({
  len: t.length,
  hasPhrase: /opera\s+sotto\s+il\s+regime\s+di\s+autoassicurazione/i.test(t),
  hasAuto: /autoassicur/i.test(t),
  snip: t.replace(/\s+/g, " ").slice(0, 1000),
}));
