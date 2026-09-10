#!/usr/bin/env node

import assert from "node:assert/strict";
import { analyzePolicy } from "../src/lib/sanita/detector.ts";

const analysis = analyzePolicy(`
  DATI ASSICURATIVI responsabilità civile verso Terzi RCT
  CASA DI CURA MADONNA DELLO SCOGLIO
  AmTrust Agency Insurance Italy Srl
  Polizza n. RCIO0010000382
  Scadenza 31/12/2025
`);

assert.equal(analysis.policyFound, true);
assert.equal(analysis.policyNumber, "RCI00010000382");
assert.equal(analysis.expiry?.toISOString(), "2025-12-31T00:00:00.000Z");
console.log("OK RCI policy number OCR normalization");
