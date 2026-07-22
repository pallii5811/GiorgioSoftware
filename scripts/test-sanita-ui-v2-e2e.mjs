/**
 * E2E Playwright — UI sanita v2 (redesign read-only).
 * Scenari obbligatori da mandato FASE 6:
 *  1. "Tutte" resta ALL dopo 3+ cicli di polling (nessun reset filtri dal polling)
 *  2. Campania mostra solo Campania; 3. ritorno a Tutte
 *  4/5/6/7. filtri esito reali: valida/scaduta/sconosciuta/HOT
 *  8. tab "Nuovi risultati del run" mostra i risultati shadow
 *  9. count mostrato = count API = righe DOM
 * 10. refresh conserva i filtri (URLSearchParams)
 * 11. nessun errore console
 * 12. nessuna griglia di box multipli (una sola card sopra i tab)
 * 13. tab default = Nuovi risultati del run
 *
 * Env: BASE_URL (default http://168.119.253.47:3000)
 * Report: data/playwright-ui-v2/report.json
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://168.119.253.47:3000";
const REPORT = "data/playwright-ui-v2/report.json";

const results = [];
const consoleErrors = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: ok === "SKIP" ? "SKIP" : Boolean(ok), detail });
  console.log(`${ok === "SKIP" ? "SKIP" : ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
page.on("console", (m) => {
  if (m.type() === "error" && !/React DevTools|Download the React|ExperimentalWarning/i.test(m.text())) {
    consoleErrors.push(m.text().slice(0, 300));
  }
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 300)}`));

const regionVal = () => page.locator('[data-testid="region-filter"]').inputValue();
const outcomeVal = () => page.locator('[data-testid="outcome-filter"]').inputValue();
const rowCount = async () => page.locator('[data-testid="lead-row"]').count();
const resultsCountText = async () =>
  Number(((await page.locator('[data-testid="results-count"]').textContent()) || "0").replace(/[^\d]/g, ""));
const rowRegions = async () => page.locator('[data-testid="lead-row"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-region")));
const rowOutcomes = async () => page.locator('[data-testid="lead-row"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-outcome")));
const selectTab = async (testid) => {
  await page.locator(`[data-testid="${testid}"]`).click();
  await page.waitForTimeout(1800); // fetch on tab enter
};
const sleep = (ms) => page.waitForTimeout(ms);

async function apiJson(path) {
  const res = await page.request.get(`${BASE}${path}`);
  return res.json();
}

try {
  // ---- 13. default tab ----
  await page.goto(`${BASE}/sanita`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector('[data-testid="main-tabs"]', { timeout: 20000 });
  await page.waitForSelector('[data-testid="revalidation-panel"]', { timeout: 20000 });
  await sleep(2500); // boot fetches
  const selected = await page.locator('[data-testid="main-tabs"] [aria-selected="true"]').getAttribute("data-testid");
  check("default tab = Nuovi risultati del run", selected === "tab-run-results", String(selected));

  // ---- 12. una sola card sopra i tab ----
  const panelCount = await page.locator('[data-testid="revalidation-panel"]').count();
  const tabsTop = await page.locator('[data-testid="main-tabs"]').boundingBox();
  const extraCards = await page.locator('[data-testid$="-panel"], [data-testid$="-card"]').evaluateAll(
    (els, top) => els.filter((e) => {
      const r = e.getBoundingClientRect();
      return r.bottom <= top && e.getAttribute("data-testid") !== "revalidation-panel";
    }).length,
    tabsTop?.y ?? 0
  );
  check("una sola card sopra i tab (nessuna griglia box)", panelCount === 1 && extraCards === 0, `panels=${panelCount} extra=${extraCards}`);

  // ---- 1. Tutte resta ALL dopo 3+ cicli polling (~16s, polling 5s) ----
  check("region default ALL", (await regionVal()) === "ALL");
  await sleep(16000);
  const afterPolls = await regionVal();
  const urlAfterPolls = page.url();
  check(
    "Tutte resta ALL dopo 3+ cicli polling",
    afterPolls === "ALL" && !/region=Campania|region=Veneto/.test(urlAfterPolls),
    `region=${afterPolls} url=${urlAfterPolls}`
  );

  // ---- 2/3. Campania solo Campania, poi ritorno a Tutte (su archivio: dati garantiti) ----
  await selectTab("tab-archive");
  await page.waitForSelector('[data-testid="lead-row"]', { timeout: 15000 });
  const totalAll = await rowCount();
  await page.selectOption('[data-testid="region-filter"]', "Campania");
  await sleep(800);
  const campaniaRows = await rowCount();
  const regions = await rowRegions();
  check(
    "Campania mostra solo Campania",
    campaniaRows > 0 && regions.every((r) => r === "Campania"),
    `rows=${campaniaRows} bad=${regions.filter((r) => r !== "Campania").length}`
  );
  // il polling non deve resettare la scelta dell'utente (direzione opposta del bug storico)
  await sleep(11000);
  check("Campania resta Campania dopo 2 cicli polling", (await regionVal()) === "Campania");
  await page.selectOption('[data-testid="region-filter"]', "ALL");
  await sleep(800);
  const backToAll = await rowCount();
  check("ritorno a Tutte ripristina l'insieme", backToAll === totalAll, `all=${totalAll} back=${backToAll}`);

  // ---- 4-7. filtri esito reali (archivio live; SKIP se sottotipo assente nel dataset) ----
  const outcomeCases = [
    ["policy_valid", "Polizza valida solo valide"],
    ["policy_expired", "Polizza scaduta solo scadute"],
    ["date_unknown", "Scadenza sconosciuta solo corrispondenti"],
    ["hot", "HOT solo HOT"],
  ];
  for (const [key, label] of outcomeCases) {
    await page.selectOption('[data-testid="outcome-filter"]', "ALL");
    await sleep(400);
    await page.selectOption('[data-testid="outcome-filter"]', key);
    await sleep(800);
    const n = await rowCount();
    if (n === 0) {
      check(label, "SKIP", `0 righe per ${key} nel dataset archivio`);
    } else {
      const outcomes = await rowOutcomes();
      check(label, outcomes.every((o) => o === key), `rows=${n} bad=${outcomes.filter((o) => o !== key).length}`);
    }
  }
  await page.selectOption('[data-testid="outcome-filter"]', "ALL");
  await sleep(600);

  // ---- 8. tab run mostra i risultati shadow; 9. count = API = DOM ----
  await selectTab("tab-run-results");
  await sleep(1500);
  const apiRun = await apiJson("/api/sanita/archive-revalidation/results?scope=run");
  const domRun = await rowCount();
  const shownRun = await resultsCountText();
  check(
    "tab Nuovi risultati del run: righe = risultati shadow API",
    apiRun.success && domRun === Math.min(apiRun.results.length, 500),
    `api=${apiRun.results?.length} dom=${domRun}`
  );
  check(
    "count mostrato = count API = righe DOM (tab run)",
    shownRun === domRun && shownRun === Math.min(apiRun.meta?.total ?? -1, 500),
    `shown=${shownRun} dom=${domRun} apiTotal=${apiRun.meta?.total}`
  );

  // count coerente anche su tab review (API outcome=REVIEW_HUMAN)
  await selectTab("tab-review");
  await sleep(1500);
  const apiReview = await apiJson("/api/sanita/archive-revalidation/results?scope=all&outcome=REVIEW_HUMAN");
  const domReview = await rowCount();
  const reviewOutcomes = await rowOutcomes();
  check(
    "tab Da controllare: solo review, count = API",
    apiReview.success && domReview === Math.min(apiReview.results.length, 500) && reviewOutcomes.every((o) => o === "review"),
    `api=${apiReview.results?.length} dom=${domReview}`
  );

  // ---- 10. refresh conserva i filtri ----
  await selectTab("tab-archive");
  await page.selectOption('[data-testid="region-filter"]', "Campania");
  await page.selectOption('[data-testid="outcome-filter"]', "policy_expired");
  await page.fill('[data-testid="search-input"]', "villa");
  await sleep(900);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="main-tabs"]', { timeout: 20000 });
  await sleep(1500);
  const okRefresh =
    (await regionVal()) === "Campania" &&
    (await outcomeVal()) === "policy_expired" &&
    (await page.locator('[data-testid="search-input"]').inputValue()) === "villa" &&
    /region=Campania/.test(page.url()) &&
    /outcome=policy_expired/.test(page.url()) &&
    /q=villa/.test(page.url());
  check("refresh conserva i filtri (URLSearchParams)", okRefresh, page.url());

  // reset filtri per cortesia verso altri test manuali
  await page.goto(`${BASE}/sanita`, { waitUntil: "domcontentloaded" });
} catch (e) {
  check("esecuzione E2E senza eccezioni", false, String(e).slice(0, 300));
} finally {
  // ---- 11. nessun errore console ----
  check("nessun errore console", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  await browser.close();
}

const failed = results.filter((r) => r.ok === false).length;
const skipped = results.filter((r) => r.ok === "SKIP").length;
fs.mkdirSync("data/playwright-ui-v2", { recursive: true });
fs.writeFileSync(
  REPORT,
  JSON.stringify({ at: new Date().toISOString(), base: BASE, failed, skipped, results, consoleErrors }, null, 1)
);
console.log(failed === 0 ? `E2E OK (${results.length - skipped} pass, ${skipped} skip)` : `E2E ${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
