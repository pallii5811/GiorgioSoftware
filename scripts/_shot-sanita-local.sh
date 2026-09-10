#!/usr/bin/env bash
# Screenshot on server against localhost (authoritative blue UI)
set -euo pipefail
cd /opt/leadsniper
OUT=/tmp/sanita-ui-shots
mkdir -p "$OUT"
node --input-type=module <<'JS'
import { chromium } from "playwright";
import fs from "fs";
const OUT = "/tmp/sanita-ui-shots";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("http://127.0.0.1:3000/sanita", { waitUntil: "networkidle", timeout: 120000 });
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/after-hero-1440.png`, fullPage: false });
const tech = page.getByText("Dettagli tecnici e controlli");
if (await tech.count()) { await tech.first().click(); await page.waitForTimeout(400); }
await page.screenshot({ path: `${OUT}/after-tech-1440.png`, fullPage: false });
await page.setViewportSize({ width: 1920, height: 1100 });
await page.screenshot({ path: `${OUT}/after-hero-1920.png`, fullPage: false });
const body = await page.locator("body").innerText();
fs.writeFileSync(`${OUT}/checks.json`, JSON.stringify({
  hasArchivioStrutture: /Archivio strutture/i.test(body),
  hasRivalidazione: /Rivalidazione archivio/i.test(body),
  hasCoda: /Coda commerciale/i.test(body),
  hasNonAncora: /Non ancora certificati/i.test(body),
  noInRivalidazioneLabel: !/In rivalidazione/i.test(body),
  has64: /64/.test(body),
  has877: /877/.test(body),
  has919: /919/.test(body),
  has11: /\b11\b/.test(body),
  errors,
}, null, 2));
console.log(fs.readFileSync(`${OUT}/checks.json`, "utf8"));
await browser.close();
JS
