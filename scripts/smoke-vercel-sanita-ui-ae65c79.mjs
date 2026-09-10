/**
 * Smoke Vercel production Sanità UI redesign (ae65c79).
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "https://giorgio-software.vercel.app";
const OUT = process.env.OUT || path.join("data", "sanita-ui-redesign-vercel-ae65c79");
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`page:${e}`));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(`console:${msg.text()}`);
});

await page.goto(`${BASE}/sanita`, { waitUntil: "domcontentloaded", timeout: 120_000 });
await page.waitForTimeout(6000);

const body = await page.locator("body").innerText();
await page.screenshot({ path: path.join(OUT, "vercel-1440.png"), fullPage: false });

await page.setViewportSize({ width: 1920, height: 1100 });
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(OUT, "vercel-1920.png"), fullPage: false });

// archive API via same origin (proxied)
let archive = null;
try {
  archive = await page.evaluate(async () => {
    const r = await fetch("/api/sanita/archive-revalidation", { cache: "no-store" });
    return { status: r.status, json: await r.json() };
  });
} catch (e) {
  archive = { error: String(e) };
}

const checks = {
  base: BASE,
  hasArchivioStrutture: /Archivio strutture/i.test(body),
  hasRivalidazioneArchivio: /Rivalidazione archivio/i.test(body),
  hasCodaCommerciale: /Coda commerciale/i.test(body),
  hasArchivioCompleto: /Archivio completo/i.test(body),
  hasStatoVerifiche: /Stato verifiche/i.test(body),
  noInRivalidazione908: !/In rivalidazione\s*:?\s*908/i.test(body),
  noHOTChip: !/\bHOT\b/.test((body.split("Filtra")[1] || "").slice(0, 300)),
  noLEGACY: !/LEGACY/i.test(body),
  noADMIN: !/\(ADMIN\)/i.test(body) && !/\bADMIN\b/.test(body),
  noShadow: !/\bshadow\b/i.test(body),
  has919: /\b919\b/.test(body),
  has877: /\b877\b/.test(body),
  has11: /\b11\b/.test(body),
  commercialTabsDefault: /Coda commerciale/i.test(body),
  archiveApi: archive,
  consoleErrors: errors.slice(0, 30),
};
fs.writeFileSync(path.join(OUT, "smoke.json"), JSON.stringify(checks, null, 2));
console.log(JSON.stringify(checks, null, 2));
await browser.close();
if (errors.length) process.exitCode = 2;
