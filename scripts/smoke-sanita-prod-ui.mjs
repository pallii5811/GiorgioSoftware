import { chromium } from "playwright";
import fs from "fs";

fs.mkdirSync("tmp-v3-export/ui-smoke", { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const posts = [];
page.on("request", (r) => {
  if (r.method() === "POST" && r.url().includes("/api/sanita")) posts.push(r.url());
});
await page.goto("https://giorgio-software.vercel.app/sanita", {
  waitUntil: "networkidle",
  timeout: 120000,
});
await page.waitForSelector("text=877");
await page.screenshot({ path: "tmp-v3-export/ui-smoke/prod-sanita-hero.png" });
const text = await page.locator("body").innerText();
const ok = {
  tot877: text.includes("877"),
  ven366: text.includes("366"),
  cam511: text.includes("511"),
  codaZero: /CODA COMMERCIALE CERTIFICATA\s*\n\s*0/i.test(text),
  banner: text.includes("Rivalidazione completa in corso"),
  protected: /PROTETTA/i.test(text),
  postsOnLoad: posts,
};
await page.getByRole("button", { name: "Coda commerciale certificata" }).click();
await page.waitForTimeout(1500);
await page.screenshot({ path: "tmp-v3-export/ui-smoke/prod-sanita-coda.png" });
const t2 = await page.locator("body").innerText();
ok.commercialMsg = /Coda commerciale vuota|fail-closed/i.test(t2);
console.log(JSON.stringify(ok, null, 2));
await browser.close();
if (!ok.tot877 || !ok.ven366 || !ok.cam511 || !ok.banner || ok.postsOnLoad.length) {
  process.exit(1);
}
