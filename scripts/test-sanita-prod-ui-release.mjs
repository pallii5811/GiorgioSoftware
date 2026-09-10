/**
 * Production E2E for /sanita 4-tab UI on Vercel.
 * Usage: node scripts/test-sanita-prod-ui-release.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "https://giorgio-software.vercel.app";
const OUT = process.env.OUT || path.join("data", "sanita-ui-prod-release");
fs.mkdirSync(OUT, { recursive: true });

const report = {
  base: BASE,
  startedAt: new Date().toISOString(),
  checks: {},
  errors: [],
};

function ok(name, pass, detail) {
  report.checks[name] = { pass: Boolean(pass), detail: detail ?? null };
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

try {
  await page.goto(`${BASE}/sanita`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForSelector('[data-testid="main-tabs"]', { timeout: 30000 });

  const tabLabels = await page.locator('[data-testid="main-tabs"] button').allTextContents();
  ok("four_tabs", tabLabels.length === 4, JSON.stringify(tabLabels));
  ok("no_coda_commerciale", !tabLabels.some((t) => /coda commerciale/i.test(t)), tabLabels.join("|"));
  ok("no_stato_verifiche", !tabLabels.some((t) => /stato verifiche/i.test(t)), tabLabels.join("|"));
  ok(
    "expected_tabs",
    /Nuovi risultati/i.test(tabLabels.join(" ")) &&
      /Tutti i certificati/i.test(tabLabels.join(" ")) &&
      /In lavorazione/i.test(tabLabels.join(" ")) &&
      /Archivio completo/i.test(tabLabels.join(" ")),
    tabLabels.join("|")
  );

  await page.screenshot({ path: path.join(OUT, "01-tab-run.png"), fullPage: false });

  // Legacy KPI label
  const legacyKpi = await page.locator('[data-testid="kpi-legacy-certified"]').textContent();
  ok("legacy_labeled", /Legacy commerciali/i.test(legacyKpi || ""), legacyKpi);

  // Region ALL persistence for 20s + tab change
  await page.selectOption('[data-testid="region-filter"]', "ALL");
  await page.waitForTimeout(20000);
  let region = await page.locator('[data-testid="region-filter"]').inputValue();
  ok("all_after_20s", region === "ALL", region);
  await page.click('[data-testid="tab-live-queue"]');
  await page.waitForTimeout(1500);
  region = await page.locator('[data-testid="region-filter"]').inputValue();
  ok("all_after_tab_change", region === "ALL", region);
  await page.screenshot({ path: path.join(OUT, "02-tab-live.png"), fullPage: false });

  // Click completed progress
  await page.click('[data-testid="completed-progress-link"]');
  await page.waitForTimeout(2500);
  const runSelected = await page.locator('[data-testid="tab-run-results"]').getAttribute("aria-selected");
  const url = page.url();
  ok("click_completed_opens_run", runSelected === "true", `aria=${runSelected} url=${url}`);
  ok("url_no_campania", !/[?&]region=Campania/i.test(url), url);
  const rowCount = await page.locator('[data-testid="lead-row"]').count();
  const countText = await page.locator('[data-testid="results-count"]').textContent();
  ok("run_rows_visible", rowCount > 0, `rows=${rowCount} count=${countText}`);
  const sources = await page.locator('[data-testid="source-badge"]').allTextContents();
  ok(
    "run_rows_are_current_engine",
    sources.length > 0 &&
      sources.every((s) => /Nuovo motore|Nuova scansione|Scansione territorio/i.test(s)),
    sources.slice(0, 5).join(",")
  );

  await page.selectOption('[data-testid="region-filter"]', "Calabria");
  await page.waitForTimeout(500);

  // Category filters
  for (const key of ["policy_valid", "policy_expired", "date_unknown", "self_insurance", "hot", "review"]) {
    await page.click(`[data-testid="outcome-card-${key}"]`);
    await page.waitForTimeout(800);
    const retainedRegion = await page.locator('[data-testid="region-filter"]').inputValue();
    ok(
      `filter_${key}_keeps_region`,
      retainedRegion === "Calabria" && /[?&]region=Calabria/.test(page.url()),
      `region=${retainedRegion} url=${page.url()}`
    );
    const outcomes = await page.locator('[data-testid="lead-row"]').evaluateAll((rows) =>
      rows.map((r) => r.getAttribute("data-outcome"))
    );
    const pass = outcomes.length === 0 || outcomes.every((o) => o === key);
    ok(`filter_${key}`, pass, `n=${outcomes.length}`);
  }

  // Autoassicurata should include Malzoni / Villa Dei Pini if present in run
  await page.selectOption('[data-testid="region-filter"]', "ALL");
  await page.click('[data-testid="outcome-card-self_insurance"]');
  await page.waitForTimeout(1000);
  const names = await page.locator('[data-testid="lead-row"] td:first-child').allTextContents();
  ok(
    "self_insurance_malzoni_or_pini",
    names.some((n) => /Malzoni|Villa Dei Pini/i.test(n)),
    names.join(" | ")
  );

  await page.click('[data-testid="tab-review"]');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(OUT, "03-tab-working.png"), fullPage: false });
  ok("working_tab", true, page.url());

  await page.click('[data-testid="tab-archive"]');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(OUT, "04-tab-archive.png"), fullPage: false });
  const hasRevalCol = (await page.locator('th:has-text("Stato rivalidazione")').count()) > 0;
  ok("archive_reval_column", hasRevalCol);

  // API counter reconciliation via proxied endpoint
  const api = await page.evaluate(async () => {
    const r = await fetch("/api/sanita/archive-revalidation", { cache: "no-store" });
    return r.json();
  });
  const sum =
    (api.certifiedCurrentRun || 0) +
    (api.reviewCurrent || 0) +
    (api.otherNonCommercialTerminal || 0) +
    (api.technicalBlockedFinal || 0);
  ok(
    "counter_reconciliation",
    sum === api.terminalCompleted,
    `sum=${sum} terminal=${api.terminalCompleted} cert=${api.certifiedCurrentRun} SI=${api.selfInsurance} review=${api.reviewCurrent}`
  );

  const runApi = await page.evaluate(async () => {
    const r = await fetch("/api/sanita/archive-revalidation/results?scope=run", { cache: "no-store" });
    return r.json();
  });
  ok("scope_run_api", runApi.success && Array.isArray(runApi.results), `n=${runApi.results?.length}`);

  const workApi = await page.evaluate(async () => {
    const r = await fetch("/api/sanita/archive-revalidation/results?scope=working&limit=500", {
      cache: "no-store",
    });
    return r.json();
  });
  ok("scope_working_api", workApi.success && Array.isArray(workApi.results), `n=${workApi.results?.length}`);

  report.api = {
    terminalCompleted: api.terminalCompleted,
    certifiedCurrentRun: api.certifiedCurrentRun,
    selfInsurance: api.selfInsurance,
    reviewCurrent: api.reviewCurrent,
    otherNonCommercialTerminal: api.otherNonCommercialTerminal,
    technicalBlockedFinal: api.technicalBlockedFinal,
    runResults: runApi.results?.length,
    workingResults: workApi.results?.length,
  };
} catch (e) {
  report.errors.push(String(e?.stack || e));
  console.error(e);
  await page.screenshot({ path: path.join(OUT, "error.png"), fullPage: true }).catch(() => {});
} finally {
  report.finishedAt = new Date().toISOString();
  const failed = Object.values(report.checks).filter((c) => !c.pass).length;
  report.failed = failed;
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(`\nREPORT ${OUT}/report.json failed=${failed}`);
  process.exit(failed > 0 || report.errors.length ? 1 : 0);
}
