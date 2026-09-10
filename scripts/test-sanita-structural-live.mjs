/**
 * Live screenshots + UI vs API count check against Hetzner blue UI.
 * Does not mock — uses real data. Worker untouched.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = (process.env.BASE_URL || "http://168.119.253.47:3000").replace(/\/$/, "");
const OUT = process.env.OUT_DIR || path.join("data", "sanita-structural-live");
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});

const api = await (await fetch(`${BASE}/api/sanita/archive-revalidation`)).json();
const sanita = await (await fetch(`${BASE}/api/sanita?includePending=1&includeAll=1`)).json();

await page.goto(`${BASE}/sanita`, { waitUntil: "domcontentloaded", timeout: 120_000 });
await page.waitForSelector('[data-testid="revalidation-panel"]', { timeout: 60_000 });
await page.waitForTimeout(2500);

const panel = await page.locator('[data-testid="revalidation-panel"]').innerText();
const header = await page.locator("header").filter({ hasText: "Verifica polizze" }).innerText();

async function shot(name, w) {
  await page.setViewportSize({ width: w, height: 1100 });
  await page.waitForTimeout(200);
  const f = path.join(OUT, `${name}-${w}.png`);
  await page.screenshot({ path: f, fullPage: true });
  return f;
}

const shots = [];
shots.push(await shot("desktop", 1440));
shots.push(await shot("desktop", 1920));

await page.locator('[data-testid="tab-certified"]').click();
await page.waitForTimeout(300);
shots.push(await shot("risultati-certificati", 1440));
shots.push(await shot("risultati-certificati", 1920));

await page.locator('[data-testid="focus-run_published"]').click();
await page.waitForTimeout(400);
const pubRows = await page.locator('[data-testid="lead-row"]').count();
const pubEmpty = await page.locator('[data-testid="leads-empty"]').count();
shots.push(await shot("published-nuovo-run", 1440));
shots.push(await shot("published-nuovo-run", 1920));

await page.locator('[data-testid="focus-run_hot"]').click();
await page.waitForTimeout(400);
const hotRows = await page.locator('[data-testid="lead-row"]').count();
const hotChip = await page.locator('[data-testid="focus-run_hot"] span.font-semibold').innerText();
shots.push(await shot("hot-nuovo-run", 1440));
shots.push(await shot("hot-nuovo-run", 1920));

// Region Tutte persistence smoke
await page.locator('[data-testid="region-ALL"]').click();
await page.waitForTimeout(200);
await page.locator('[data-testid="region-Campania"]').click();
await page.waitForTimeout(200);
await page.locator('[data-testid="region-ALL"]').click();
await page.waitForTimeout(200);
const regionCls = await page.locator('[data-testid="region-ALL"]').getAttribute("class");
const regionOk = (regionCls || "").includes("bg-slate-900");

const report = {
  base: BASE,
  api: {
    terminalCompleted: api.terminalCompleted,
    targetTotal: api.targetTotal,
    published: api.published,
    hot: api.hot,
    reviewCurrent: api.reviewCurrent,
    technicalBlockedFinal: api.technicalBlockedFinal,
    recordsTouched: api.recordsTouched,
    currentlyInProgress: api.currentlyInProgress,
    currentRetryQueue: api.currentRetryQueue,
    terminalIdsHot: api.terminalIds?.hot?.length ?? 0,
    terminalIdsPublished: api.terminalIds?.published?.length ?? 0,
  },
  sanitaMeta: {
    dbTotal: sanita.meta?.dbTotal,
    actionableCount: sanita.meta?.actionableCount,
  },
  ui: {
    header,
    panel: panel.slice(0, 400),
    runPublishedRows: pubRows,
    runPublishedEmpty: pubEmpty > 0,
    runHotRows: hotRows,
    runHotChip: Number(hotChip),
    regionTutteActive: regionOk,
  },
  countsMatch: {
    hotChipEqRows: Number(hotChip) === hotRows,
    hotChipEqApi: Number(hotChip) === (api.terminalIds?.hot?.length ?? api.hot ?? -1),
    publishedRowsEqApi:
      pubRows === (api.terminalIds?.published?.length ?? api.published ?? -1),
  },
  consoleErrors: consoleErrors.filter((t) => !/FedCM|GSI|WebSocket|webpack-hmr/i.test(t)),
  shots,
};

fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
process.exit(report.countsMatch.hotChipEqRows && regionOk ? 0 : 1);
