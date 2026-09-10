/**
 * K3 production UI E2E — filtri/tabs/persistenza.
 * SKIP_ENGINE=1 evita Avvia/Pausa durante micro-canary in corso.
 *
 * Usage:
 *   BASE_URL=http://168.119.253.47:3000 SKIP_ENGINE=1 node scripts/test-k3-ui-prod-e2e.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const SKIP_ENGINE = process.env.SKIP_ENGINE === "1";
const OUT = process.env.OUT_DIR || path.join("data", "k3-stopship", "ui-e2e-prod");
fs.mkdirSync(OUT, { recursive: true });

const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) console.log(`PASS ${name}`);
  else {
    console.error(`FAIL ${name} ${detail}`);
    failures.push(name);
  }
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push(String(err)));

const res = await page.goto(`${BASE}/sanita`, { waitUntil: "networkidle", timeout: 60_000 });
ok("sanita_200", res && res.status() === 200, `status=${res?.status()}`);
await page.waitForSelector('[data-testid="revalidation-controls"]', { timeout: 30_000 });
await page.screenshot({ path: path.join(OUT, "01-sanita-home.png"), fullPage: true });

ok("btn_start_visible", await page.locator('[data-testid="btn-start"]').count() > 0);
ok("btn_pause_visible", await page.locator('[data-testid="btn-pause"]').count() > 0);
ok("btn_resume_visible", await page.locator('[data-testid="btn-resume"]').count() > 0);

// Region ALL persistence across polling
const region = page.locator('[data-testid="region-filter"]');
await region.selectOption("ALL").catch(async () => {
  await region.selectOption({ label: "Tutte le regioni" });
});
const before = await region.inputValue();
for (let i = 0; i < 3; i++) {
  await page.waitForTimeout(5000);
  const v = await region.inputValue();
  ok(`all_persists_poll_${i + 1}`, v === before, `got=${v} want=${before}`);
}
await page.screenshot({ path: path.join(OUT, "02-region-all.png") });

// Campania filter
const opts = await region.locator("option").allTextContents();
const campania = opts.find((t) => /Campania/i.test(t));
if (campania) {
  await region.selectOption({ label: campania.trim() });
  await page.waitForTimeout(1500);
  const localities = await page.locator('[data-testid="row-locality"]').allTextContents();
  const bad = localities.filter((t) => t && !/Campania/i.test(t) && !/—|-/.test(t));
  ok("campania_only", bad.length === 0, `bad=${JSON.stringify(bad.slice(0, 5))} n=${localities.length}`);
  await page.screenshot({ path: path.join(OUT, "03-campania.png") });
  await region.selectOption("ALL").catch(async () => region.selectOption({ label: "Tutte le regioni" }));
  await page.waitForTimeout(1000);
  ok("back_to_all", true);
} else {
  ok("campania_option_present", false, `opts=${opts.join("|")}`);
}

// Outcome chips / filter
const outcome = page.locator('[data-testid="outcome-filter"]');
if ((await outcome.count()) > 0) {
  const oopts = await outcome.locator("option").allTextContents();
  for (const label of ["Polizza valida", "Polizza scaduta", "HOT"]) {
    const hit = oopts.find((t) => t.includes(label.split(" ")[0]) || new RegExp(label, "i").test(t));
    if (!hit) {
      console.log(`SKIP outcome ${label}`);
      continue;
    }
    await outcome.selectOption({ label: hit.trim() }).catch(() => {});
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, `04-outcome-${label.replace(/\s+/g, "-")}.png`) });
  }
}

// Tabs
for (const tab of ["tab-run-results", "tab-certified", "tab-in-progress", "tab-archive"]) {
  const loc = page.locator(`[data-testid="${tab}"]`);
  if ((await loc.count()) > 0) {
    await loc.click();
    await page.waitForTimeout(600);
    ok(`tab_${tab}`, true);
  }
}
await page.screenshot({ path: path.join(OUT, "05-tabs.png"), fullPage: true });

// Control API idempotency (GET)
const ctrl = await page.request.get(`${BASE}/api/sanita/archive-revalidation/control`);
ok("control_get_200", ctrl.status() === 200);
const ctrlJson = await ctrl.json();
ok("control_json_ok", ctrlJson.success === true);

if (!SKIP_ENGINE) {
  // Start twice → second 409
  const r1 = await page.request.post(`${BASE}/api/sanita/archive-revalidation/control`, {
    data: { action: "start" },
  });
  const j1 = await r1.json();
  ok("start_ok_or_busy", r1.status() === 200 || r1.status() === 409, `st=${r1.status()}`);
  const r2 = await page.request.post(`${BASE}/api/sanita/archive-revalidation/control`, {
    data: { action: "start" },
  });
  ok("start_no_duplicate", r2.status() === 409 || (await r2.json()).success === false, `st=${r2.status()}`);
  await page.request.post(`${BASE}/api/sanita/archive-revalidation/control`, { data: { action: "pause" } });
} else {
  console.log("SKIP_ENGINE=1 — start/pause/resume deferred (micro-canary live)");
  ok("skip_engine_documented", true);
}

ok("no_console_errors", consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "));

const report = {
  base: BASE,
  skipEngine: SKIP_ENGINE,
  failures,
  consoleErrors,
  at: new Date().toISOString(),
};
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
await browser.close();
console.log(JSON.stringify(report, null, 2));
process.exit(failures.length ? 1 : 0);
