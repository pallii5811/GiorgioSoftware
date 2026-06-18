import { launchMapsBrowser } from "../src/lib/sanita/playwright-maps.ts";
import { extractPdfFullText, terminateOcrWorker } from "../src/lib/sanita/ocr.ts";
import { analyzePolicy } from "../src/lib/sanita/detector.ts";

const url = "https://www.villadeifioriacerra.it/trasparenza/";
const { browser, context, page } = await launchMapsBrowser();
const pdfUrls = new Set();

page.on("response", async (res) => {
  const u = res.url();
  if (/\.pdf/i.test(u)) pdfUrls.add(u);
});

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3000);

  const before = await page.evaluate(() =>
    [...document.querySelectorAll("a[href]")].map((a) => a.href).filter((h) => /\.pdf/i.test(h))
  );
  console.log("PDF links before clicks:", before);

  for (const label of ["Parm 2026", "PARM 2026", "Parm 2025", "Annualità", "risk management", "Piano Annuale"]) {
    const loc = page.getByText(new RegExp(label, "i"));
    const n = await loc.count();
    console.log("click", label, "count", n);
    for (let i = 0; i < Math.min(n, 3); i++) {
      await loc.nth(i).click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
  }

  const after = await page.evaluate(() =>
    [...document.querySelectorAll("a[href]")].map((a) => a.href).filter((h) => /\.pdf/i.test(h))
  );
  console.log("PDF links after clicks:", after);
  console.log("Network PDFs:", [...pdfUrls]);

  const text = await page.evaluate(() => document.body?.innerText ?? "");
  console.log("text len", text.length, "has RCT", /RCT|RCO|AM Trust|polizza assicurativa/i.test(text));
  console.log("analyzePolicy page", JSON.stringify(analyzePolicy(text)));

  for (const pdf of [...new Set([...after, ...pdfUrls])].slice(0, 5)) {
    const res = await fetch(pdf);
    const buf = Buffer.from(await res.arrayBuffer());
    const { text: pt } = await extractPdfFullText(buf);
    console.log("PDF", pdf.slice(-60), "chars", pt.length, "policy", analyzePolicy(pt).policyFound);
  }
} finally {
  await page.close().catch(() => {});
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  await terminateOcrWorker().catch(() => {});
}
