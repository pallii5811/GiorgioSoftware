import { launchMapsBrowser } from "../src/lib/sanita/playwright-maps.ts";
import { analyzePolicy } from "../src/lib/sanita/detector.ts";

const url = process.argv[2] ?? "https://centrominerva.org/amministrazione-trasparente/";
const { browser, context, page } = await launchMapsBrowser();
try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2000);
  for (const sel of [
    "text=/copertura assicurativa/i",
    ".accordion-button",
    "summary",
    "[aria-expanded='false']",
  ]) {
    const loc = page.locator(sel);
    const n = Math.min(await loc.count(), 14);
    for (let i = 0; i < n; i++) await loc.nth(i).click({ timeout: 2000 }).catch(() => {});
  }
  await page.waitForTimeout(1000);
  const text = await page.evaluate(() => document.body?.innerText?.replace(/\s+/g, " ") ?? "");
  console.log("chars:", text.length);
  console.log("analyze:", JSON.stringify(analyzePolicy(text), null, 2));
  console.log("snip:", text.match(/copertura[\s\S]{0,300}/i)?.[0]);
} finally {
  await page.close().catch(() => {});
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}
