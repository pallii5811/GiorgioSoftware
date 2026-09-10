/**
 * Structural Sanità UI — filter E2E (Playwright).
 * Mocks APIs via addInitScript (window.fetch) — more reliable than route() with Next/Turbopack.
 *
 *   node scripts/test-sanita-structural-filters.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const OUT_DIR = process.env.OUT_DIR || path.join("data", "sanita-structural-ui");
const PORT = Number(process.env.PORT || 3031);
const BASE_URL = (process.env.BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const START_DEV = !process.env.BASE_URL;

fs.mkdirSync(OUT_DIR, { recursive: true });

const MOCK = {
  archive: {
    success: true,
    available: true,
    active: true,
    statusLabel: "Verifica in corso",
    targetTotal: 877,
    percent: 2.4,
    updatedAt: "2026-07-21T18:00:00.000Z",
    recordsTouched: 77,
    terminalCompleted: 21,
    currentlyInProgress: 1,
    currentRetryQueue: 5,
    reviewCurrent: 8,
    technicalBlockedFinal: 12,
    certifiedCurrentRun: 2,
    hot: 1,
    published: 1,
    terminalIds: {
      hot: ["hot-run"],
      published: ["pub-run"],
      review: ["review-1"],
      technical: [],
    },
    processed: 77,
    terminal: 21,
    certifiedResults: 2,
    checksNeeded: 8,
    technicalPending: 12,
    absenceFound: 1,
  },
  sanita: {
    success: true,
    data: [
      {
        id: "pub-valid",
        osmId: null,
        companyName: "Clinica Valida SPA",
        region: "Veneto",
        category: "Clinica",
        website: "https://valida.example",
        city: "Padova",
        phone: null,
        email: null,
        policyFound: true,
        policyCompany: "Generali",
        policyMassimale: "5M",
        policyNumber: null,
        policyExpiry: "2027-12-31",
        confidence: 90,
        websiteReachable: true,
        lastScannedAt: "2026-07-01T10:00:00.000Z",
        status: "NEW",
        evidence: "[PS:PUBLISHED_CURRENT] [BV:PUBLISHED_CURRENT]",
        pec: null,
        piva: null,
        leadScore: 80,
        notes: null,
        reminderAt: null,
        semantic: {
          actionable: true,
          processingState: "PUBLISHED_CURRENT",
          businessVerdict: "PUBLISHED_CURRENT",
        },
        _actionable: true,
      },
      {
        id: "pub-expired",
        osmId: null,
        companyName: "Poliambulatorio Scaduto",
        region: "Campania",
        category: "Poliambulatorio",
        website: "https://scaduto.example",
        city: "Napoli",
        phone: null,
        email: null,
        policyFound: true,
        policyCompany: "Unipol",
        policyMassimale: null,
        policyNumber: null,
        policyExpiry: "2024-01-15",
        confidence: 85,
        websiteReachable: true,
        lastScannedAt: "2026-07-02T10:00:00.000Z",
        status: "NEW",
        evidence: "[PS:PUBLISHED_EXPIRED] [BV:PUBLISHED_EXPIRED]",
        pec: null,
        piva: null,
        leadScore: 70,
        notes: null,
        reminderAt: null,
        semantic: {
          actionable: true,
          processingState: "PUBLISHED_EXPIRED",
          businessVerdict: "PUBLISHED_EXPIRED",
        },
        _actionable: true,
      },
      {
        id: "pub-unknown",
        osmId: null,
        companyName: "Casa di Cura Data Ignota",
        region: "Campania",
        category: "Casa di cura",
        website: "https://ignota.example",
        city: "Salerno",
        phone: null,
        email: null,
        policyFound: true,
        policyCompany: "Allianz",
        policyMassimale: null,
        policyNumber: null,
        policyExpiry: null,
        confidence: 70,
        websiteReachable: true,
        lastScannedAt: "2026-07-03T10:00:00.000Z",
        status: "NEW",
        evidence: "[PS:PUBLISHED_DATE_UNKNOWN] [BV:PUBLISHED_DATE_UNKNOWN]",
        pec: null,
        piva: null,
        leadScore: 60,
        notes: null,
        reminderAt: null,
        semantic: {
          actionable: true,
          processingState: "PUBLISHED_DATE_UNKNOWN",
          businessVerdict: "PUBLISHED_DATE_UNKNOWN",
        },
        _actionable: true,
      },
      {
        id: "hot-run",
        osmId: null,
        companyName: "RSA Hot Nuovo Run",
        region: "Veneto",
        category: "RSA",
        website: "https://hot.example",
        city: "Verona",
        phone: null,
        email: null,
        policyFound: false,
        policyCompany: null,
        policyMassimale: null,
        policyNumber: null,
        policyExpiry: null,
        confidence: 95,
        websiteReachable: true,
        lastScannedAt: "2026-07-20T12:00:00.000Z",
        status: "NEW",
        evidence: "[PS:HOT_VERIFIED] [BV:HOT_VERIFIED]",
        pec: null,
        piva: null,
        leadScore: 95,
        notes: null,
        reminderAt: null,
        semantic: {
          actionable: true,
          processingState: "HOT_VERIFIED",
          businessVerdict: "HOT_VERIFIED",
        },
        _actionable: true,
      },
      {
        id: "pub-run",
        osmId: null,
        companyName: "Published Nuovo Run",
        region: "Campania",
        category: "Clinica",
        website: "https://pubrun.example",
        city: "Caserta",
        phone: null,
        email: null,
        policyFound: true,
        policyCompany: "Reale Mutua",
        policyMassimale: null,
        policyNumber: null,
        policyExpiry: "2026-11-01",
        confidence: 88,
        websiteReachable: true,
        lastScannedAt: "2026-07-20T13:00:00.000Z",
        status: "NEW",
        evidence: "[PS:PUBLISHED_CURRENT] [BV:PUBLISHED_CURRENT]",
        pec: null,
        piva: null,
        leadScore: 88,
        notes: null,
        reminderAt: null,
        semantic: {
          actionable: true,
          processingState: "PUBLISHED_CURRENT",
          businessVerdict: "PUBLISHED_CURRENT",
        },
        _actionable: true,
      },
      {
        id: "review-1",
        osmId: null,
        companyName: "Struttura Da Controllare",
        region: "Veneto",
        category: "Ambulatorio",
        website: "https://review.example",
        city: "Vicenza",
        phone: null,
        email: null,
        policyFound: null,
        policyCompany: null,
        policyMassimale: null,
        policyNumber: null,
        policyExpiry: null,
        confidence: 40,
        websiteReachable: true,
        lastScannedAt: "2026-07-10T10:00:00.000Z",
        status: "NEW",
        evidence: "[PS:REVIEW_HUMAN] [BV:REVIEW_HUMAN]",
        pec: null,
        piva: null,
        leadScore: 40,
        notes: null,
        reminderAt: null,
        semantic: {
          actionable: false,
          processingState: "REVIEW_HUMAN",
          businessVerdict: "REVIEW_HUMAN",
        },
        _actionable: false,
      },
    ],
    meta: {
      dbTotal: 919,
      actionableCount: 5,
      totalReturned: 6,
      includeAll: true,
      regions: {
        Veneto: { total: 400, done: 200, pending: 200 },
        Campania: { total: 519, done: 300, pending: 219 },
      },
      kpis: {
        total: 919,
        actionable: 5,
        HOT_VERIFIED: 1,
        PUBLISHED_CURRENT: 2,
        PUBLISHED_EXPIRED: 1,
        PUBLISHED_DATE_UNKNOWN: 1,
        RETRY_PENDING: 0,
        REVIEW_HUMAN: 1,
        TECHNICAL_BLOCKED: 0,
        OUT_OF_SCOPE: 0,
        inRevalidation: 914,
        notYetCertified: 914,
        LEGACY: 0,
        commercial: {
          policyValid: 2,
          policyExpired: 1,
          dateUnknown: 1,
          absenceCertified: 1,
        },
      },
    },
  },
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForServer(url, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status > 0) return;
    } catch {
      /* retry */
    }
    await sleep(1000);
  }
  throw new Error(`Server not ready: ${url}`);
}

async function startDev() {
  const child = spawn("npx", ["next", "start", "-p", String(PORT)], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });
  let log = "";
  child.stdout.on("data", (d) => {
    log += d.toString();
  });
  child.stderr.on("data", (d) => {
    log += d.toString();
  });
  await waitForServer(`${BASE_URL}/sanita`);
  return { child, log: () => log };
}

async function installFetchMock(page) {
  await page.addInitScript((mock) => {
    const json = (body) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const orig = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const u = typeof input === "string" ? input : input?.url || String(input);
      if (u.includes("/api/sanita/archive-revalidation")) return json(mock.archive);
      if (u.includes("/api/sanita/jobs")) return json({ success: true, jobs: [] });
      if (u.includes("/api/sanita")) return json(mock.sanita);
      return orig(input, init);
    };
    window.__SANITA_MOCK__ = true;
  }, MOCK);
}

async function activeRegion(page) {
  const buttons = page.locator('[data-testid="region-filter"] button');
  const n = await buttons.count();
  for (let i = 0; i < n; i++) {
    const b = buttons.nth(i);
    const cls = (await b.getAttribute("class")) || "";
    if (cls.includes("bg-slate-900")) return (await b.innerText()).trim();
  }
  return null;
}

async function rowCount(page) {
  return page.locator('[data-testid="lead-row"]').count();
}

async function resultCountLabel(page) {
  const t = await page.locator('[data-testid="result-count"]').innerText();
  const m = t.match(/^(\d+)/);
  return m ? Number(m[1]) : -1;
}

function chipCountText(locator) {
  return locator.locator("span.font-semibold").innerText();
}

async function shot(page, name, width) {
  await page.setViewportSize({ width, height: 1100 });
  await page.waitForTimeout(200);
  const file = path.join(OUT_DIR, `${name}-${width}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

const report = { ok: false, checks: [], consoleErrors: [], screenshots: [], counts: {} };

function check(name, pass, detail) {
  report.checks.push({ name, pass, detail });
  console.log(pass ? "PASS" : "FAIL", name, detail ?? "");
}

async function main() {
  let dev = null;
  if (START_DEV) {
    console.log("starting next on", PORT);
    dev = await startDev();
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  await installFetchMock(page);
  await page.goto(`${BASE_URL}/sanita`, { waitUntil: "domcontentloaded", timeout: 120_000 });

  await page.waitForSelector('[data-testid="revalidation-panel"]', { timeout: 60_000 });
  // Force refresh if first paint raced before mock (should not be needed)
  const mocked = await page.evaluate(() => window.__SANITA_MOCK__ === true);
  check("fetch-mock-installed", mocked, null);
  await page.waitForSelector('[data-testid="leads-table"]', { timeout: 60_000 });
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="result-count"]')?.textContent || "").match(/^[1-9]/),
    null,
    { timeout: 30_000 }
  );

  check(
    "default-tab-certified",
    ((await page.locator('[data-testid="tab-certified"]').getAttribute("class")) || "").includes(
      "bg-white"
    ),
    null
  );
  check("no-status-tab", (await page.locator('[data-testid="tab-status"]').count()) === 0, null);
  check(
    "panel-progress",
    (await page.locator('[data-testid="revalidation-panel"]').innerText()).includes("21 di 877"),
    null
  );

  await page.locator('[data-testid="region-ALL"]').click();
  await page.waitForTimeout(150);
  let region = await activeRegion(page);
  check("region-tutte-selected", region === "Tutte", region);
  check("region-not-campania-when-tutte", region !== "Campania", region);

  await page.locator('[data-testid="region-Campania"]').click();
  await page.waitForTimeout(150);
  region = await activeRegion(page);
  check("region-campania", region === "Campania", region);
  const campaniaRegions = await page
    .locator('[data-testid="lead-row"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-region")));
  check(
    "region-campania-rows-only",
    campaniaRegions.length > 0 && campaniaRegions.every((r) => r === "Campania"),
    campaniaRegions
  );

  await page.locator('[data-testid="region-ALL"]').click();
  await page.waitForTimeout(150);
  region = await activeRegion(page);
  check("region-back-to-tutte", region === "Tutte", region);

  await page.locator('[data-testid="focus-policy_expired"]').click();
  await page.waitForTimeout(200);
  let rows = await rowCount(page);
  let label = await resultCountLabel(page);
  let chip = Number(await chipCountText(page.locator('[data-testid="focus-policy_expired"]')));
  check("expired-count-match", rows === label && rows === chip, { rows, label, chip });
  check("expired-only", rows === 1, null);
  report.counts.policy_expired = { chip, rows };

  await page.locator('[data-testid="focus-date_unknown"]').click();
  await page.waitForTimeout(200);
  rows = await rowCount(page);
  chip = Number(await chipCountText(page.locator('[data-testid="focus-date_unknown"]')));
  check("date-unknown-count-match", rows === chip, { rows, chip });
  report.counts.date_unknown = { chip, rows };

  await page.locator('[data-testid="focus-run_published"]').click();
  await page.waitForTimeout(200);
  rows = await rowCount(page);
  chip = Number(await chipCountText(page.locator('[data-testid="focus-run_published"]')));
  const pubIds = await page
    .locator('[data-testid="lead-row"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-lead-id")));
  check("published-run-count", rows === chip && rows === 1, { rows, chip, pubIds });
  check("published-run-id", pubIds[0] === "pub-run", pubIds);
  report.counts.run_published = { chip, rows };
  report.screenshots.push(await shot(page, "published-nuovo-run", 1440));
  report.screenshots.push(await shot(page, "published-nuovo-run", 1920));

  await page.locator('[data-testid="focus-run_hot"]').click();
  await page.waitForTimeout(200);
  rows = await rowCount(page);
  chip = Number(await chipCountText(page.locator('[data-testid="focus-run_hot"]')));
  const hotIds = await page
    .locator('[data-testid="lead-row"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-lead-id")));
  check("hot-run-count", rows === chip && rows === 1, { rows, chip, hotIds });
  check("hot-run-id", hotIds[0] === "hot-run", hotIds);
  report.counts.run_hot = { chip, rows };
  report.screenshots.push(await shot(page, "hot-nuovo-run", 1440));
  report.screenshots.push(await shot(page, "hot-nuovo-run", 1920));

  await page.locator('[data-testid="focus-all"]').click();
  await page.waitForTimeout(200);
  report.screenshots.push(await shot(page, "risultati-certificati", 1440));
  report.screenshots.push(await shot(page, "risultati-certificati", 1920));
  report.screenshots.push(await shot(page, "desktop", 1440));
  report.screenshots.push(await shot(page, "desktop", 1920));

  await page.locator('[data-testid="region-Campania"]').click();
  await page.locator('[data-testid="focus-policy_expired"]').click();
  await page.waitForTimeout(200);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="leads-table"]', { timeout: 60_000 });
  await page.waitForTimeout(500);
  region = await activeRegion(page);
  const focusCls =
    (await page.locator('[data-testid="focus-policy_expired"]').getAttribute("class")) || "";
  check(
    "refresh-preserves-url",
    page.url().includes("region=Campania") && page.url().includes("focus=policy_expired"),
    page.url()
  );
  check("refresh-preserves-region", region === "Campania", region);
  check("refresh-preserves-focus", focusCls.includes("bg-slate-900"), focusCls);

  await page.locator('[data-testid="focus-policy_valid"]').click();
  await page.waitForTimeout(150);
  region = await activeRegion(page);
  check("focus-change-keeps-region", region === "Campania", region);

  await page.locator('[data-testid="region-ALL"]').click();
  await page.locator('[data-testid="tab-review"]').click();
  await page.waitForTimeout(150);
  region = await activeRegion(page);
  check("tab-change-keeps-tutte", region === "Tutte", region);

  const gifDir = path.join(OUT_DIR, "filter-demo-frames");
  fs.mkdirSync(gifDir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('[data-testid="tab-certified"]').click();
  const steps = [
    ["01-tutte", async () => page.locator('[data-testid="region-ALL"]').click()],
    ["02-campania", async () => page.locator('[data-testid="region-Campania"]').click()],
    ["03-tutte", async () => page.locator('[data-testid="region-ALL"]').click()],
    ["04-expired", async () => page.locator('[data-testid="focus-policy_expired"]').click()],
    ["05-date-unknown", async () => page.locator('[data-testid="focus-date_unknown"]').click()],
    ["06-pub-run", async () => page.locator('[data-testid="focus-run_published"]').click()],
    ["07-hot-run", async () => page.locator('[data-testid="focus-run_hot"]').click()],
  ];
  for (const [name, fn] of steps) {
    await fn();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(gifDir, `${name}.png`) });
  }
  report.filterDemoFrames = gifDir;

  // Build a simple animated GIF if gifencoder/sharp not required — stitch note in report
  report.consoleErrors = consoleErrors.filter(
    (t) => !/FedCM|GSI_LOGGER|Failed to load resource.*(403|429)|webpack-hmr|WebSocket/i.test(t)
  );
  check("no-console-errors", report.consoleErrors.length === 0, report.consoleErrors);

  report.ok = report.checks.every((c) => c.pass);
  fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  console.log("\nREPORT", report.ok ? "OK" : "FAILED", OUT_DIR);

  await browser.close();
  if (dev?.child) {
    try {
      process.kill(dev.child.pid);
    } catch {
      /* ignore */
    }
  }
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
