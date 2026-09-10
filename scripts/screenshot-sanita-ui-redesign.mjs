/**
 * Screenshot Sanità UI after client-ready redesign (Hetzner blue).
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://168.119.253.47:3000";
const OUT = process.env.OUT || path.join("data", "sanita-ui-redesign");
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});

await page.goto(`${BASE}/sanita`, { waitUntil: "domcontentloaded", timeout: 120_000 });
await page.waitForTimeout(4000);
await page.screenshot({ path: path.join(OUT, "after-hero-1440.png"), fullPage: false });

// expand technical details
const tech = page.getByText("Dettagli tecnici e controlli");
if (await tech.count()) {
  await tech.first().click();
  await page.waitForTimeout(500);
}
await page.screenshot({ path: path.join(OUT, "after-tech-open-1440.png"), fullPage: false });

await page.setViewportSize({ width: 1920, height: 1100 });
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(OUT, "after-hero-1920.png"), fullPage: false });

// scroll full page
await page.screenshot({ path: path.join(OUT, "after-full-1440.png"), fullPage: true });

const body = await page.locator("body").innerText();
const checks = {
  noInRivalidazione908: !/In rivalidazione\s*908/i.test(body) && !/In rivalidazione:\s*908/i.test(body),
  hasNonAncoraCertificati: /Non ancora certificati/i.test(body),
  hasCodaCommerciale: /Coda commerciale/i.test(body),
  hasArchivioCompleto: /Archivio completo/i.test(body),
  hasStatoVerifiche: /Stato verifiche/i.test(body),
  hasRivalidazioneArchivio: /Rivalidazione archivio/i.test(body),
  has64of877: /64/.test(body) && /877/.test(body),
  noHOTFilterLabel: !/\bHOT\b/.test(body.split("Filtra")[1]?.slice(0, 200) || ""),
  consoleErrors: errors.slice(0, 20),
};
fs.writeFileSync(path.join(OUT, "checks.json"), JSON.stringify(checks, null, 2));
console.log(JSON.stringify({ out: OUT, checks }, null, 2));
await browser.close();
