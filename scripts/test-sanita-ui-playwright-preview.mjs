/**
 * UI Playwright canary — Vercel Preview (proxies jobs to Hetzner).
 *
 * Usage:
 *   BASE_URL="https://...vercel.app" node scripts/test-sanita-ui-playwright-preview.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE_URL = (process.env.BASE_URL || "").replace(/\/$/, "");
const VERCEL_SHARE_URL = process.env.VERCEL_SHARE_URL || "";
const RECOVERY_JOB_ID =
  process.env.RECOVERY_JOB_ID || "88854d1b-f589-42f9-8114-9eb915020e0d";
const OUT_DIR = process.env.OUT_DIR || path.join("data", "playwright-ui-canary");
const BROWSER_CLOSE_MS = Number(process.env.BROWSER_CLOSE_MS || 25_000);
const SINGLE_TIMEOUT_MS = Number(process.env.SINGLE_TIMEOUT_MS || 600_000);

if (!BASE_URL) {
  console.error("BASE_URL required");
  process.exit(2);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const FORBIDDEN_UI = [
  "HOT_VERIFIED",
  "RETRY_PENDING",
  "REVIEW_HUMAN",
  "TECHNICAL_BLOCKED",
  "OUT_OF_SCOPE",
  "LEGACY",
  "crawl",
  "frontier",
  "evidence",
  "runId",
];
const ALLOWED_JOB_ROUTES = [
  /^POST \/api\/sanita\/jobs$/,
  /^GET \/api\/sanita\/jobs/,
  /^POST \/api\/sanita\/jobs\/[^/]+\/cancel$/,
  /^GET \/api\/sanita(\?|$)/,
];
const FORBIDDEN_ROUTES = [
  /\/api\/sanita\/stream/,
  /^POST \/api\/sanita$/,
];

const networkLog = [];
const consoleErrors = [];
let legacyRouteHits = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function trackRequest(req) {
  const u = new URL(req.url());
  if (!u.pathname.startsWith("/api/sanita")) return;
  const line = `${req.method()} ${u.pathname}${u.search}`;
  networkLog.push(line);
  for (const re of FORBIDDEN_ROUTES) {
    if (re.test(line)) legacyRouteHits++;
  }
}

function isBenignConsoleError(text) {
  return (
    /FedCM|GSI_LOGGER|accounts\.google|googleusercontent|gsi\/client/i.test(text) ||
    /Failed to load resource.*(403|429)/i.test(text) ||
    /vercel\.com\/sso-api/i.test(text)
  );
}

function attachPage(page) {
  page.on("request", trackRequest);
  page.on("console", (msg) => {
    if (msg.type() === "error" && !isBenignConsoleError(msg.text())) {
      consoleErrors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    const text = String(err);
    if (!isBenignConsoleError(text)) consoleErrors.push(text);
  });
}

async function bootstrapPage(page) {
  const entry = VERCEL_SHARE_URL || BASE_URL;
  await page.goto(entry, { waitUntil: "networkidle", timeout: 120_000 });
  if (VERCEL_SHARE_URL && !page.url().includes("/sanita")) {
    await page.goto(`${BASE_URL}/sanita`, { waitUntil: "networkidle", timeout: 120_000 });
  }
  await page.getByRole("button", { name: /Tutte le strutture|Coda commerciale/i }).first().waitFor({
    state: "visible",
    timeout: 120_000,
  });
}

async function apiJson(page, apiPath, init) {
  return page.evaluate(
    async ({ apiPath, init }) => {
      const res = await fetch(apiPath, init);
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { ok: res.ok, status: res.status, json };
    },
    { apiPath, init }
  );
}

function jobCard(page) {
  return page.locator('[class*="border-indigo-200/70"][class*="bg-indigo-50/40"]').first();
}

async function switchCommercial(page) {
  await page.getByRole("button", { name: /Coda commerciale certificata/i }).click();
}

async function switchAudit(page) {
  await page.getByRole("button", { name: /Tutte le strutture \/ Audit/i }).click();
}

async function assertJobCardCustomerSafe(page) {
  const card = jobCard(page);
  await card.waitFor({ state: "visible", timeout: 60_000 });
  const text = await card.innerText();
  if (/\b553\b/.test(text)) throw new Error("Job card shows regional total 553");
  for (const term of FORBIDDEN_UI) {
    if (text.includes(term)) throw new Error(`Forbidden UI term in job card: ${term}`);
  }
  return text;
}

async function testRecovery(page, report) {
  await bootstrapPage(page);
  await switchCommercial(page);
  await page.waitForTimeout(2000);

  const latest = await apiJson(page, "/api/sanita/jobs?limit=1");
  if (!latest.ok || !latest.json?.jobs?.[0]) throw new Error("No latest job from API");
  const job = latest.json.jobs[0];
  report.recovery.apiJobId = job.jobId;
  if (job.jobId !== RECOVERY_JOB_ID) {
    throw new Error(`Expected recovery job ${RECOVERY_JOB_ID}, got ${job.jobId}`);
  }
  if (job.status !== "completed") throw new Error(`Recovery job not completed: ${job.status}`);
  if (job.progress?.totalStructures !== 3) {
    throw new Error(`Recovery totalStructures=${job.progress?.totalStructures}`);
  }
  if (job.progress?.structuresControlled !== 3) {
    throw new Error(`Recovery structuresControlled=${job.progress?.structuresControlled}`);
  }

  const cardText = await assertJobCardCustomerSafe(page);
  if (!/completato/i.test(cardText) && !/Completato/.test(job.lastUpdateLabel || "")) {
    throw new Error("Recovery job missing Completato label");
  }
  if (!cardText.includes("3 / 3") && !cardText.includes("3/3")) {
    throw new Error(`Recovery card missing 3/3: ${cardText.slice(0, 200)}`);
  }
  await page.screenshot({ path: path.join(OUT_DIR, "a-recovery-completed.png"), fullPage: true });
  report.recovery.pass = true;
}

async function waitForJobApi(page, jobId, statuses, timeoutMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const j = await apiJson(page, `/api/sanita/jobs/${jobId}`);
    const status = j.json?.job?.status;
    if (status && statuses.includes(status)) return j.json.job;
    await sleep(150);
  }
  throw new Error(`Job ${jobId} did not reach ${statuses.join("|")} within ${timeoutMs}ms`);
}

async function pickLeadForSingle(page, { preferFast = false } = {}) {
  const res = await apiJson(page, "/api/sanita?region=Campania&includeAll=1");
  const data = res.json?.data || [];
  const withSite = data.filter((l) => l.website && l.lastScannedAt);
  if (preferFast) {
    const fast =
      withSite.find((l) => /villa dei pini/i.test(l.companyName)) ||
      withSite.find((l) => /malzoni/i.test(l.companyName)) ||
      withSite[0];
    if (!fast?.id) throw new Error("No lead for single UI test");
    return fast;
  }
  const isFastSkip = (l) =>
    (/\[V:PUBLISHED\]/.test(l.evidence || "") && l.policyFound) ||
    (/\[V:HOT\]/i.test(l.evidence || "") && /scaduta da \d+ giorni/i.test(l.evidence || ""));
  const slow = withSite.filter((l) => !isFastSkip(l));
  const pick =
    slow.find((l) => /casa di vito/i.test(l.companyName)) ||
    slow.find((l) => /santa maria del pozzo/i.test(l.companyName)) ||
    slow[0] ||
    withSite[0];
  if (!pick?.id) throw new Error("No lead for single UI test");
  return pick;
}

async function testSingleWithReload(browser, report) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  attachPage(page);
  await bootstrapPage(page);
  await switchAudit(page);
  await page.waitForTimeout(1500);

  const lead = await pickLeadForSingle(page, { preferFast: true });
  report.single.leadId = lead.id;
  report.single.leadName = lead.companyName;
  report.single.crmBefore = { status: lead.status, notes: lead.notes || "" };

  const row = page.locator("tr", { hasText: lead.companyName }).first();
  await row.waitFor({ state: "visible", timeout: 60_000 });
  const rianalizza = row.getByRole("button", { name: /Rianalizza/i });
  const postPromise = page.waitForResponse(
    (r) => r.url().includes("/api/sanita/jobs") && r.request().method() === "POST",
    { timeout: 60_000 }
  );
  await rianalizza.click();
  const postRes = await postPromise;
  const postBody = await postRes.json();
  const jobId = postBody?.job?.jobId;
  if (!jobId) throw new Error("single jobId missing from POST response");
  report.single.jobId = jobId;

  const card = jobCard(page);
  await card.waitFor({ state: "visible", timeout: 30_000 });
  await page.screenshot({ path: path.join(OUT_DIR, "b-single-queued.png"), fullPage: true });

  const runningJob = await waitForJobApi(page, jobId, ["running", "completed"], 180_000);
  if (runningJob.status === "running") {
    await page.screenshot({ path: path.join(OUT_DIR, "b-single-running.png"), fullPage: true });
  } else {
    report.single.fastComplete = true;
    await page.screenshot({ path: path.join(OUT_DIR, "b-single-running.png"), fullPage: true });
  }

  if (runningJob.status === "running") {
    await page.close();
    await sleep(BROWSER_CLOSE_MS);

    const page2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    attachPage(page2);
    await bootstrapPage(page2);
    await switchAudit(page2);
    await page2.waitForTimeout(3000);

    const latest = await apiJson(page2, "/api/sanita/jobs?limit=1");
    const recoveredId = latest.json?.jobs?.[0]?.jobId;
    report.single.recoveredJobId = recoveredId;
    if (recoveredId !== jobId) {
      throw new Error(`Reload recovery mismatch: expected ${jobId}, got ${recoveredId}`);
    }
    await assertJobCardCustomerSafe(page2);
    await page2.screenshot({ path: path.join(OUT_DIR, "b-single-after-reopen.png"), fullPage: true });

    const t0 = Date.now();
    while (Date.now() - t0 < SINGLE_TIMEOUT_MS) {
      const j = await apiJson(page2, `/api/sanita/jobs/${jobId}`);
      const status = j.json?.job?.status;
      if (status === "completed" || status === "cancelled" || status === "failed") {
        report.single.finalStatus = status;
        break;
      }
      await sleep(5000);
      await page2.reload({ waitUntil: "domcontentloaded" });
      await page2.waitForTimeout(1500);
    }
    if (!report.single.finalStatus) throw new Error("Single job did not finish in time");

    await page2.screenshot({ path: path.join(OUT_DIR, "b-single-completed.png"), fullPage: true });

    const leadAfterRes = await apiJson(page2, `/api/sanita?region=Campania&includeAll=1`);
    const leadAfter = (leadAfterRes.json?.data || []).find((l) => l.id === lead.id);
    report.single.crmAfter = { status: leadAfter?.status, notes: leadAfter?.notes || "" };
    if (report.single.crmBefore.status !== report.single.crmAfter.status) {
      throw new Error("CRM status changed");
    }
    if (report.single.crmBefore.notes !== report.single.crmAfter.notes) {
      throw new Error("CRM notes changed");
    }

    await page2.close();
    report.single.pass = true;
    return;
  }

  // Job finished before browser close — still verify reopen shows completed job.
  await page.close();
  await sleep(5000);
  const page2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  attachPage(page2);
  await bootstrapPage(page2);
  await switchAudit(page2);
  await page2.waitForTimeout(2000);
  const latest = await apiJson(page2, `/api/sanita/jobs?limit=1`);
  report.single.recoveredJobId = latest.json?.jobs?.[0]?.jobId;
  if (report.single.recoveredJobId !== jobId) {
    throw new Error(`Reload recovery mismatch: expected ${jobId}, got ${report.single.recoveredJobId}`);
  }
  report.single.finalStatus = runningJob.status;
  await assertJobCardCustomerSafe(page2);
  await page2.screenshot({ path: path.join(OUT_DIR, "b-single-after-reopen.png"), fullPage: true });
  await page2.screenshot({ path: path.join(OUT_DIR, "b-single-completed.png"), fullPage: true });
  const leadAfterRes = await apiJson(page2, `/api/sanita?region=Campania&includeAll=1`);
  const leadAfter = (leadAfterRes.json?.data || []).find((l) => l.id === lead.id);
  report.single.crmAfter = { status: leadAfter?.status, notes: leadAfter?.notes || "" };
  if (report.single.crmBefore.status !== report.single.crmAfter.status) {
    throw new Error("CRM status changed");
  }
  if (report.single.crmBefore.notes !== report.single.crmAfter.notes) {
    throw new Error("CRM notes changed");
  }
  await page2.close();
  report.single.pass = true;
}

async function testCancel(browser, report) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  attachPage(page);
  await bootstrapPage(page);
  await switchAudit(page);

  const lead = await pickLeadForSingle(page, { preferFast: true });
  const row = page.locator("tr", { hasText: lead.companyName }).first();
  await row.getByRole("button", { name: /Rianalizza/i }).click();
  await page.waitForResponse(
    (r) => r.url().includes("/api/sanita/jobs") && r.request().method() === "POST",
    { timeout: 60_000 }
  );

  const created = await apiJson(page, "/api/sanita/jobs?limit=1");
  const jobId = created.json?.jobs?.[0]?.jobId;
  report.cancel.jobId = jobId;

  await page.getByRole("button", { name: /Interrompi/i }).click({ timeout: 60_000 });
  await page.waitForResponse(
    (r) => r.url().includes("/cancel") && r.request().method() === "POST",
    { timeout: 60_000 }
  );

  const t0 = Date.now();
  let final = null;
  while (Date.now() - t0 < 120_000) {
    const j = await apiJson(page, `/api/sanita/jobs/${jobId}`);
    final = j.json?.job;
    if (final?.status === "cancelled") break;
    await sleep(2000);
  }
  if (final?.status !== "cancelled") throw new Error(`Cancel status=${final?.status}`);
  if (final?.pid) throw new Error(`Cancel pid not null: ${final.pid}`);
  if (!/interrotto/i.test(final?.lastUpdateLabel || "")) {
    throw new Error(`Cancel missing Interrotto label: ${final?.lastUpdateLabel}`);
  }

  await page.screenshot({ path: path.join(OUT_DIR, "c-cancelled.png"), fullPage: true });

  // Dedup: stesso target deve poter ripartire
  await row.getByRole("button", { name: /Rianalizza/i }).click();
  const res2 = await page.waitForResponse(
    (r) => r.url().includes("/api/sanita/jobs") && r.request().method() === "POST",
    { timeout: 60_000 }
  );
  const body = await res2.json();
  if (!body?.success) throw new Error("Dedup blocked new job on same target");
  report.cancel.newJobId = body.job?.jobId;
  if (body.job?.jobId === jobId) throw new Error("Same jobId after cancel relaunch");

  await page.getByRole("button", { name: /Interrompi/i }).click({ timeout: 60_000 }).catch(() => {});
  await page.close();
  report.cancel.pass = true;
}

async function main() {
  const report = {
    baseUrl: BASE_URL,
    vercelShareUrl: VERCEL_SHARE_URL || null,
    recoveryJobId: RECOVERY_JOB_ID,
    recovery: {},
    single: {},
    cancel: {},
    networkLog: [],
    legacyRouteHits: 0,
    consoleErrors: [],
    pass: false,
  };

  const browser = await chromium.launch({ headless: true });
  const skipRecovery = process.env.SKIP_RECOVERY === "1";
  const skipCancel = process.env.SKIP_CANCEL === "1";
  try {
    if (!skipRecovery) {
      const pageA = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      attachPage(pageA);
      await testRecovery(pageA, report);
      await pageA.close();
    } else {
      report.recovery.skipped = true;
      report.recovery.pass = true;
    }
  } catch (e) {
    report.recovery.error = String(e?.message || e);
  }

  try {
    await testSingleWithReload(browser, report);
  } catch (e) {
    report.single.error = String(e?.message || e);
  }

  try {
    if (!skipCancel) {
      await testCancel(browser, report);
    } else {
      report.cancel.skipped = true;
      report.cancel.pass = true;
    }
  } catch (e) {
    report.cancel.error = String(e?.message || e);
  }

  await browser.close();

  report.networkLog = networkLog;
  report.legacyRouteHits = legacyRouteHits;
  report.consoleErrors = consoleErrors;
  report.pass =
    report.recovery.pass === true &&
    report.single.pass === true &&
    report.cancel.pass === true &&
    legacyRouteHits === 0 &&
    consoleErrors.length === 0;

  const outPath = path.join(OUT_DIR, "report.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
