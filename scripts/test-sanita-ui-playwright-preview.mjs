/**
 * UI Playwright gate — Vercel Preview (proxies jobs to Hetzner).
 *
 * Usage:
 *   BASE_URL="https://....vercel.app" VERCEL_SHARE_URL="..." node scripts/test-sanita-ui-playwright-preview.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const BASE_URL = (process.env.BASE_URL || "").replace(/\/$/, "");
const VERCEL_SHARE_URL = (process.env.VERCEL_SHARE_URL || "").replace(/\/$/, "");
const RECOVERY_JOB_ID =
  process.env.RECOVERY_JOB_ID || "88854d1b-f589-42f9-8114-9eb915020e0d";
const POSITIVE_LEAD_ID = process.env.POSITIVE_LEAD_ID || "cmqkld5rt009n108es4nx3g1j";
const NEGATIVE_LEAD_ID = process.env.NEGATIVE_LEAD_ID || "cmqktyimz000i111hygme29nh";
const OUT_DIR = process.env.OUT_DIR || path.join("data", "playwright-ui-canary");
const BROWSER_CLOSE_MS = Number(process.env.BROWSER_CLOSE_MS || 60_000);
const SINGLE_TIMEOUT_MS = Number(process.env.SINGLE_TIMEOUT_MS || 600_000);
const EXPECT_SHA = process.env.EXPECT_SHA || "3f5873532119a81b7477e3ec458e414e242f41e6";
const HETZNER_HOST = process.env.HETZNER_HOST || "root@168.119.253.47";

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
const FORBIDDEN_ROUTES = [
  /\/api\/sanita\/stream/,
  /^POST \/api\/sanita$/,
];

const networkLog = [];
const consoleErrors = [];
const consoleWarnings = [];
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

function isFedCmWarning(text) {
  return /FedCM|GSI_LOGGER|accounts\.google|googleusercontent|gsi\/client|Provider's accounts list is empty/i.test(
    text
  );
}

function isBenignConsoleError(text) {
  return (
    isFedCmWarning(text) ||
    /Failed to load resource.*(403|429)/i.test(text) ||
    /vercel\.com\/sso-api/i.test(text)
  );
}

function attachPage(page) {
  page.on("request", trackRequest);
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "warning" && isFedCmWarning(text)) {
      consoleWarnings.push(text);
      return;
    }
    if (msg.type() === "error" && !isBenignConsoleError(text)) {
      consoleErrors.push(text);
    }
  });
  page.on("pageerror", (err) => {
    const text = String(err);
    if (!isBenignConsoleError(text)) consoleErrors.push(text);
  });
}

function hetznerQuery(opts = {}) {
  const args = [path.join("scripts", "verify-sanita-gate-hetzner.mjs")];
  if (opts.requireSha) args.push(`--requireSha=${opts.requireSha}`);
  if (opts.jobId) args.push(`--jobId=${opts.jobId}`);
  if (opts.leadId) args.push(`--leadId=${opts.leadId}`);
  if (opts.targetKey) args.push(`--targetKey=${opts.targetKey}`);
  if (opts.requireAudit) args.push("--requireAudit=1");
  if (opts.requireZombieZero) args.push("--requireZombieZero=1");
  if (opts.failOnError) args.push("--failOnError=1");
  const out = execFileSync("node", args, { encoding: "utf8", cwd: process.cwd() });
  const line = out.trim().split("\n").pop();
  return JSON.parse(line);
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

async function waitForJobApi(page, jobId, statuses, timeoutMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const j = await apiJson(page, `/api/sanita/jobs/${jobId}`);
    const status = j.json?.job?.status;
    if (status && statuses.includes(status)) return j.json.job;
    await sleep(500);
  }
  throw new Error(`Job ${jobId} did not reach ${statuses.join("|")} within ${timeoutMs}ms`);
}

async function pollJobTerminal(page, jobId, timeoutMs = SINGLE_TIMEOUT_MS) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const j = await apiJson(page, `/api/sanita/jobs/${jobId}`);
    const job = j.json?.job;
    const status = job?.status;
    if (status === "completed" || status === "cancelled" || status === "failed") {
      return job;
    }
    await sleep(3000);
  }
  throw new Error(`Job ${jobId} timeout`);
}

async function pickLeadForSingle(page, { preferFast = false, leadId = null } = {}) {
  const res = await apiJson(page, "/api/sanita?region=Campania&includeAll=1");
  const data = res.json?.data || [];
  if (leadId) {
    const exact = data.find((l) => l.id === leadId);
    if (!exact) throw new Error(`Lead ${leadId} not found`);
    return exact;
  }
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

async function startSingleJobFromRow(page, row) {
  const postPromise = page.waitForResponse(
    (r) =>
      r.url().includes("/api/sanita/jobs") &&
      r.request().method() === "POST" &&
      !r.url().includes("/cancel"),
    { timeout: 90_000 }
  );
  await row.getByRole("button", { name: /Rianalizza/i }).click();
  const postRes = await postPromise;
  const postBody = await postRes.json();
  if (!postRes.ok() || !postBody?.job?.jobId) {
    throw new Error(`POST /api/sanita/jobs failed: ${postRes.status()} ${JSON.stringify(postBody)}`);
  }
  return postBody.job.jobId;
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
  await page.screenshot({ path: path.join(OUT_DIR, "a-recovery-completed.png"), fullPage: true });
  report.recovery.pass = true;
}

async function testBrowserCloseNonFastSkip(browser, report) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  attachPage(page);
  await bootstrapPage(page);
  await switchAudit(page);
  await page.waitForTimeout(1500);

  const lead = await pickLeadForSingle(page, { preferFast: false });
  report.browserClose.leadId = lead.id;
  report.browserClose.leadName = lead.companyName;
  report.browserClose.crmBefore = { status: lead.status, notes: lead.notes || "" };

  const row = page.locator("tr", { hasText: lead.companyName }).first();
  await row.waitFor({ state: "visible", timeout: 60_000 });
  const jobId = await startSingleJobFromRow(page, row);
  report.browserClose.jobId = jobId;

  await jobCard(page).waitFor({ state: "visible", timeout: 30_000 });
  await page.screenshot({ path: path.join(OUT_DIR, "b-browser-close-queued.png"), fullPage: true });

  await waitForJobApi(page, jobId, ["running", "completed", "failed", "cancelled"], 300_000);
  const mid = await apiJson(page, `/api/sanita/jobs/${jobId}`);
  const midStatus = mid.json?.job?.status;
  report.browserClose.statusBeforeClose = midStatus;
  if (midStatus === "running") {
    await page.screenshot({ path: path.join(OUT_DIR, "b-browser-close-running.png"), fullPage: true });
  }

  await page.close();
  await sleep(BROWSER_CLOSE_MS);

  const page2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  attachPage(page2);
  await bootstrapPage(page2);
  await switchAudit(page2);
  await page2.waitForTimeout(3000);

  const latest = await apiJson(page2, "/api/sanita/jobs?limit=1");
  const recoveredId = latest.json?.jobs?.[0]?.jobId;
  report.browserClose.recoveredJobId = recoveredId;
  if (recoveredId !== jobId) {
    throw new Error(`Reload recovery mismatch: expected ${jobId}, got ${recoveredId}`);
  }

  const final = await pollJobTerminal(page2, jobId, SINGLE_TIMEOUT_MS);
  report.browserClose.finalStatus = final.status;
  if (!["completed", "failed", "cancelled"].includes(final.status)) {
    throw new Error(`Unexpected terminal status: ${final.status}`);
  }
  if (final.status === "queued" || final.status === "running") {
    throw new Error("Job still active after timeout — zombie");
  }

  const hetzner = hetznerQuery({ requireZombieZero: true, requireSha: EXPECT_SHA });
  report.browserClose.hetzner = hetzner;

  await assertJobCardCustomerSafe(page2);
  await page2.screenshot({ path: path.join(OUT_DIR, "b-browser-close-after-reopen.png"), fullPage: true });

  const leadAfterRes = await apiJson(page2, "/api/sanita?region=Campania&includeAll=1");
  const leadAfter = (leadAfterRes.json?.data || []).find((l) => l.id === lead.id);
  report.browserClose.crmAfter = { status: leadAfter?.status, notes: leadAfter?.notes || "" };
  if (report.browserClose.crmBefore.status !== report.browserClose.crmAfter.status) {
    throw new Error("CRM status changed after browser close test");
  }

  await page2.close();
  report.browserClose.pass = true;
}

async function testCancel(browser, report) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  attachPage(page);
  await bootstrapPage(page);
  await switchAudit(page);
  await page.waitForTimeout(1500);

  const lead = await pickLeadForSingle(page, { preferFast: true });
  report.cancel.leadId = lead.id;
  report.cancel.targetKey = `single:${lead.id}`;
  const row = page.locator("tr", { hasText: lead.companyName }).first();
  await row.waitFor({ state: "visible", timeout: 60_000 });

  const jobId = await startSingleJobFromRow(page, row);
  report.cancel.jobId = jobId;
  await jobCard(page).waitFor({ state: "visible", timeout: 30_000 });

  const cancelPromise = page.waitForResponse(
    (r) => r.url().includes("/cancel") && r.request().method() === "POST",
    { timeout: 90_000 }
  );
  await page.getByRole("button", { name: /Interrompi/i }).click({ timeout: 60_000 });
  const cancelRes = await cancelPromise;
  const cancelBody = await cancelRes.json().catch(() => null);
  report.cancel.cancelHttpStatus = cancelRes.status();
  report.cancel.cancelResponseStatus = cancelBody?.job?.status;

  if (!cancelRes.ok()) throw new Error(`Cancel HTTP ${cancelRes.status()}`);

  const final = await pollJobTerminal(page, jobId, 120_000);
  if (final.status !== "cancelled") throw new Error(`Cancel status=${final.status}`);
  if (final.pid) throw new Error(`Cancel pid not null: ${final.pid}`);
  if (!/interrotto/i.test(final.lastUpdateLabel || "")) {
    throw new Error(`Cancel missing Interrotto label: ${final.lastUpdateLabel}`);
  }

  const hetznerAfterCancel = hetznerQuery({
    jobId,
    leadId: lead.id,
    targetKey: report.cancel.targetKey,
    requireSha: EXPECT_SHA,
  });
  report.cancel.lockAbsent = !hetznerAfterCancel.lockExists;
  if (hetznerAfterCancel.lockExists) {
    throw new Error(`Lock still held after cancel: ${JSON.stringify(hetznerAfterCancel.lock)}`);
  }

  await page.screenshot({ path: path.join(OUT_DIR, "c-cancelled.png"), fullPage: true });

  const restartPromise = page.waitForResponse(
    (r) =>
      r.url().includes("/api/sanita/jobs") &&
      r.request().method() === "POST" &&
      !r.url().includes("/cancel"),
    { timeout: 90_000 }
  );
  await row.getByRole("button", { name: /Rianalizza/i }).click();
  const res2 = await restartPromise;
  const body = await res2.json();
  if (!body?.success) throw new Error("Dedup blocked new job on same target");
  report.cancel.newJobId = body.job?.jobId;
  if (body.job?.jobId === jobId) throw new Error("Same jobId after cancel relaunch");

  await page.getByRole("button", { name: /Interrompi/i }).click({ timeout: 60_000 }).catch(() => {});
  await sleep(2000);
  await page.close();
  report.cancel.pass = true;
}

async function testPositiveApplyVillaFiorita(browser, report) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  attachPage(page);
  await bootstrapPage(page);
  await switchAudit(page);
  await page.waitForTimeout(1500);

  const lead = await pickLeadForSingle(page, { leadId: POSITIVE_LEAD_ID });
  report.positive.leadId = lead.id;
  report.positive.leadName = lead.companyName;
  report.positive.crmBefore = { status: lead.status, notes: lead.notes || "" };

  const beforeCommercial = await apiJson(page, "/api/sanita?region=Campania&includeAll=1");
  const actionableBefore = (beforeCommercial.json?.data || []).filter(
    (l) => l._actionable || /\[BV:PUBLISHED/.test(l.evidence || "")
  ).length;
  report.positive.actionableBefore = actionableBefore;

  const row = page.locator("tr", { hasText: lead.companyName }).first();
  await row.waitFor({ state: "visible", timeout: 60_000 });
  const jobId = await startSingleJobFromRow(page, row);
  report.positive.jobId = jobId;

  const final = await pollJobTerminal(page, jobId, SINGLE_TIMEOUT_MS);
  report.positive.finalStatus = final.status;
  report.positive.certifiedResults = final.progress?.certifiedResults ?? 0;
  if (final.status !== "completed") throw new Error(`Positive apply status=${final.status}`);
  if ((final.progress?.certifiedResults || 0) < 1) {
    throw new Error(`certifiedResults=${final.progress?.certifiedResults}`);
  }

  const hetzner = hetznerQuery({
    jobId,
    leadId: lead.id,
    requireAudit: true,
    requireSha: EXPECT_SHA,
    requireZombieZero: true,
  });
  report.positive.serverAudit = hetzner.audit;
  report.positive.serverAuditExists = hetzner.auditExists;
  if (!hetzner.auditExists) throw new Error("Server-side apply audit missing");

  const afterRes = await apiJson(page, "/api/sanita?region=Campania&includeAll=1");
  const afterLead = (afterRes.json?.data || []).find((l) => l.id === lead.id);
  report.positive.crmAfter = { status: afterLead?.status, notes: afterLead?.notes || "" };
  report.positive.processingState = hetzner.audit?.processingState;
  report.positive.evidenceUrl = (afterLead?.evidence || "").match(/\[DOCS:\s*([^\]]+)\]/i)?.[1]?.trim() || null;

  if (report.positive.crmBefore.status !== report.positive.crmAfter.status) {
    throw new Error("CRM status changed on positive apply");
  }
  if (hetzner.audit.processingState !== "PUBLISHED_CURRENT") {
    throw new Error(`Expected PUBLISHED_CURRENT got ${hetzner.audit.processingState}`);
  }

  await switchCommercial(page);
  await page.waitForTimeout(2000);
  const commercialText = await page.locator("body").innerText();
  if (!/villa fiorita/i.test(commercialText)) {
    throw new Error("Villa Fiorita not visible in commercial queue");
  }
  await page.screenshot({ path: path.join(OUT_DIR, "d-positive-commercial-queue.png"), fullPage: true });

  const actionableAfter = (afterRes.json?.data || []).filter(
    (l) => l._actionable || /\[BV:PUBLISHED/.test(l.evidence || "")
  ).length;
  report.positive.actionableAfter = actionableAfter;

  await row.click();
  await page.waitForTimeout(1500);
  if (report.positive.evidenceUrl) {
    const link = page.locator(`a[href*="${new URL(report.positive.evidenceUrl).pathname.split("/").pop()}"]`).first();
    if ((await link.count()) === 0) {
      const bodyText = await page.locator("body").innerText();
      if (!bodyText.includes(new URL(report.positive.evidenceUrl).hostname)) {
        throw new Error("Evidence URL not openable from UI");
      }
    }
  }
  await page.screenshot({ path: path.join(OUT_DIR, "d-positive-evidence-drawer.png"), fullPage: true });

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page.getByRole("button", { name: /Esporta CSV/i }).click(),
  ]);
  const csvPath = path.join(OUT_DIR, "d-positive-export.csv");
  await download.saveAs(csvPath);
  const csv = fs.readFileSync(csvPath, "utf8");
  report.positive.csvContainsLead = /villa fiorita/i.test(csv);
  if (!report.positive.csvContainsLead) throw new Error("CSV missing Villa Fiorita");

  await page.close();
  report.positive.pass = true;
}

async function testMalzoniNegative(page, report) {
  const res = await apiJson(page, "/api/sanita?region=Campania&includeAll=1");
  const lead = (res.json?.data || []).find((l) => l.id === NEGATIVE_LEAD_ID);
  if (!lead) throw new Error("Malzoni lead missing");
  const ps = (lead.evidence || "").match(/\[PS:([^\]]+)\]/)?.[1] || null;
  report.negative = {
    leadId: lead.id,
    leadName: lead.companyName,
    processingState: ps,
    hasDocs: /\[DOCS:/.test(lead.evidence || ""),
    actionable: Boolean(lead._actionable),
    crm: { status: lead.status, notes: lead.notes || "" },
  };
  if (report.negative.hasDocs) throw new Error("Malzoni unexpectedly has [DOCS:] — do not invent");
  if (report.negative.actionable) throw new Error("Malzoni must not be actionable");
  report.negative.pass = true;
}

async function main() {
  const report = {
    baseUrl: BASE_URL,
    vercelShareUrl: VERCEL_SHARE_URL || null,
    expectSha: EXPECT_SHA,
    recoveryJobId: RECOVERY_JOB_ID,
    recovery: {},
    browserClose: {},
    cancel: {},
    positive: {},
    negative: {},
    networkLog: [],
    legacyRouteHits: 0,
    consoleErrors: [],
    consoleWarnings: [],
    pass: false,
  };

  const hetznerPre = hetznerQuery({ requireSha: EXPECT_SHA, requireZombieZero: true, failOnError: true });
  report.hetznerPre = hetznerPre;

  const browser = await chromium.launch({ headless: true });
  const skipRecovery = process.env.SKIP_RECOVERY === "1";

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
    await testBrowserCloseNonFastSkip(browser, report);
  } catch (e) {
    report.browserClose.error = String(e?.message || e);
  }

  try {
    await testCancel(browser, report);
  } catch (e) {
    report.cancel.error = String(e?.message || e);
  }

  try {
    await testPositiveApplyVillaFiorita(browser, report);
  } catch (e) {
    report.positive.error = String(e?.message || e);
  }

  try {
    const pageN = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    attachPage(pageN);
    await bootstrapPage(pageN);
    await testMalzoniNegative(pageN, report);
    await pageN.close();
  } catch (e) {
    report.negative.error = String(e?.message || e);
  }

  await browser.close();

  const hetznerPost = hetznerQuery({ requireSha: EXPECT_SHA, requireZombieZero: true, failOnError: true });
  report.hetznerPost = hetznerPost;

  report.networkLog = networkLog;
  report.legacyRouteHits = legacyRouteHits;
  report.consoleErrors = consoleErrors;
  report.consoleWarnings = consoleWarnings;
  report.pass =
    report.recovery.pass === true &&
    report.browserClose.pass === true &&
    report.cancel.pass === true &&
    report.positive.pass === true &&
    report.negative.pass === true &&
    legacyRouteHits === 0 &&
    consoleErrors.length === 0 &&
    hetznerPost.zombieCount === 0 &&
    (hetznerPost.releaseSha === EXPECT_SHA ||
      hetznerPost.releaseSha?.startsWith(EXPECT_SHA.slice(0, 7)));

  const outPath = path.join(OUT_DIR, "report.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
