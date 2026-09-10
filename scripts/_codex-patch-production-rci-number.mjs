#!/usr/bin/env node

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const target = "/opt/leadsniper/src/lib/sanita/detector.ts";
const backup =
  `/opt/leadsniper/backups/detector-rci-${new Date().toISOString().replaceAll(":", "-")}.ts`;
let source = readFileSync(target, "utf8");
if (source.includes('compact.slice(3).replaceAll("O", "0")')) {
  console.log("RCI_NUMBER_NORMALIZATION_ALREADY_PRESENT");
  process.exit(0);
}

const eol = source.includes("\r\n") ? "\r\n" : "\n";
const anchor =
  "  if (/^(prodotto|sostituisce|rct|rco|polizza|numero|della|dell|art)$/i.test(n)) return null;" +
  eol;
const insertion =
  anchor +
  [
    "  // Le polizze AmTrust RCI hanno prefisso RCI seguito solo da cifre:",
    "  // OCR/font PDF possono confondere lo zero iniziale con la lettera O.",
    '  const compact = n.replace(/\\s+/g, "").toUpperCase();',
    "  if (/^RCI[0-9O]{8,}$/.test(compact)) {",
    '    return `RCI${compact.slice(3).replaceAll("O", "0")}`;',
    "  }",
    "",
  ].join(eol);

if (!source.includes(anchor)) {
  throw new Error("sanitizePolicyNumber anchor not found; refusing unsafe patch");
}
mkdirSync(dirname(backup), { recursive: true });
copyFileSync(target, backup);
source = source.replace(anchor, insertion);
writeFileSync(target, source, "utf8");
console.log(`RCI_NUMBER_NORMALIZATION_PATCHED ${backup}`);
