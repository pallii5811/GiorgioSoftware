import { launchMapsBrowser } from "../src/lib/sanita/playwright-maps.ts";
import { analyzePolicy } from "../src/lib/sanita/detector.ts";

const url =
  process.argv[2] ?? "https://www.casadicuravillaigea.it/sito/amministrazione-trasparente";

const { browser, context, page } = await launchMapsBrowser();
try {
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const text = await page.evaluate(() => document.body?.innerText?.replace(/\s+/g, " ") ?? "");
  console.log("chars:", text.length);
  const snip = text.match(/polizza[\s\S]{0,500}/i)?.[0] ?? text.slice(0, 400);
  console.log("snippet:", snip);
  console.log("analyze:", JSON.stringify(analyzePolicy(text), null, 2));
} finally {
  await page.close().catch(() => {});
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}
