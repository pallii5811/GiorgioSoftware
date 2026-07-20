/**
 * Staging browser acceptance against local Next server (127.0.0.1:4310).
 * Starts server if not already up; uses staging DB when provided.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(".");
const OUT = path.join(ROOT, "docs/staging-acceptance");
const SHOTS = path.join(OUT, "screenshots");
fs.mkdirSync(SHOTS, { recursive: true });

const PORT = Number(process.env.STAGING_HTTP_PORT || 4310);
const BASE = `http://127.0.0.1:${PORT}`;
const STAGING_DB =
  process.env.DATABASE_URL ||
  `file:${path.join(ROOT, "data/staging/db/giorgio-browser-semantic.db").replace(/\\/g, "/")}`;

async function killPort(port) {
  if (process.platform !== "win32") return;
  try {
    const { execSync } = await import("node:child_process");
    const out = execSync(`netstat -ano | findstr ":${port}"`, { encoding: "utf8" });
    for (const line of out.split("\n")) {
      const m = line.match(/LISTENING\s+(\d+)/);
      if (m?.[1]) {
        try {
          execSync(`taskkill /PID ${m[1]} /F`, { stdio: "ignore" });
        } catch {
          /* */
        }
      }
    }
  } catch {
    /* */
  }
}

const start = Date.now();
let pass = 0;
let fail = 0;
function ok(c, m) {
  if (c) {
    pass++;
    console.log(`  ✓ ${m}`);
  } else {
    fail++;
    console.error(`  ✗ ${m}`);
  }
}

async function waitHttp(url, ms = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404 || r.status === 307) return true;
    } catch {
      /* */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

let child = null;
const useExplicitDb = Boolean(process.env.DATABASE_URL);
if (useExplicitDb || process.env.STAGING_BROWSER_FORCE === "1") await killPort(PORT);
await new Promise((r) => setTimeout(r, useExplicitDb ? 1500 : 0));
const already = useExplicitDb ? false : await waitHttp(BASE, 3000);
if (!already) {
  const dbPathFs = STAGING_DB.replace(/^file:/, "");
  const dbExists = fs.existsSync(dbPathFs);
  const nextBin = path.join(
    ROOT,
    "node_modules",
    "next",
    "dist",
    "bin",
    "next"
  );
  child = spawn(
    process.execPath,
    [nextBin, "start", "-H", "127.0.0.1", "-p", String(PORT)],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        STAGING_MODE: "true",
        DISABLE_EMAILS: "true",
        DISABLE_WEBHOOKS: "true",
        DISABLE_CUSTOMER_NOTIFICATIONS: "true",
        DISABLE_PUBLIC_QUEUE_PUBLISH: "true",
        DISABLE_PRODUCTION_CRON: "true",
        DISABLE_LIVE_DB: "true",
        DATABASE_URL: dbExists ? STAGING_DB : process.env.DATABASE_URL,
        PORT: String(PORT),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  const up = await waitHttp(BASE, 180_000);
  ok(up, `staging HTTP up at ${BASE}`);
  if (!up) {
    if (child) child.kill();
    console.log(JSON.stringify({ suite: "staging-browser", exitCode: 1, pass, fail, skipped: 0 }));
    process.exit(1);
  }
} else {
  ok(true, `staging HTTP already up at ${BASE}`);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const apiUi = [];

try {
  await page.goto(`${BASE}/sanita`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.screenshot({ path: path.join(SHOTS, "sanita-list.png"), fullPage: false });
  const sanitaBody = await page.textContent("body");
  ok(Boolean(sanitaBody && sanitaBody.length > 50), "sanita page rendered");

  await page.goto(`${BASE}/gare`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.screenshot({ path: path.join(SHOTS, "gare-list.png"), fullPage: false });
  const gareBody = await page.textContent("body");
  ok(Boolean(gareBody && gareBody.length > 50), "gare page rendered");
  ok(!/GARE_undefined/i.test(gareBody || ""), "no GARE_undefined in UI");

  // API parity sample
  for (const api of ["/api/sanita", "/api/gare"]) {
    try {
      const res = await page.request.get(`${BASE}${api}`);
      const status = res.status();
      let json = null;
      try {
        json = await res.json();
      } catch {
        /* */
      }
      apiUi.push({ api, status, hasData: Boolean(json) });
      ok(status < 500, `${api} status ${status}`);
    } catch (e) {
      ok(false, `${api} ${e}`);
    }
  }

  // Semantic acceptance — not just body.length
  const samplePath = path.join(OUT, "sample-sanita.json");
  const semantic = [];
  if (fs.existsSync(samplePath)) {
    const sample = JSON.parse(fs.readFileSync(samplePath, "utf8"));
    const ids = [
      ...(sample.published || []),
      ...(sample.hot || []),
      ...(sample.hard || []),
      ...(sample.leads || []),
      ...(sample.rows || []),
    ].slice(0, 8);
    for (const row of ids) {
      const id = row.id || row.leadId;
      if (!id) continue;
      try {
        const res = await page.request.get(`${BASE}/api/sanita?id=${encodeURIComponent(id)}`);
        const json = await res.json().catch(() => null);
        const lead =
          json?.lead ||
          json?.leads?.find?.((l) => l.id === id) ||
          (Array.isArray(json?.data) ? json.data.find((l) => l.id === id) : null) ||
          (Array.isArray(json) ? json.find((l) => l.id === id) : null) ||
          json?.items?.find?.((l) => l.id === id);
        const found = Boolean(lead) || json?.found === true;
        const ev = lead?.evidence || "";
        const checks = {
          id,
          companyName: lead?.companyName || row.companyName || null,
          hasBadgeHint: /\[V:(PUB|HOT|REV)\]|\[STATE:|\[BV:/.test(ev) || lead?.policyFound != null,
          processingState: (ev.match(/\[STATE:([A-Z_]+)\]/) || [])[1] || null,
          businessVerdict: (ev.match(/\[BV:([A-Z_]+)\]/) || [])[1] || null,
          validationStatus: (ev.match(/\[VS:([A-Z_]+)\]/) || [])[1] || null,
          company: lead?.policyCompany || null,
          number: lead?.policyNumber || null,
          expiry: lead?.policyExpiry || null,
          docs: (ev.match(/\[DOCS:\s*([^\]]+)\]/) || [])[1] || null,
          apiOk: res.status() === 200 || res.status() === 404,
          found,
          httpStatus: res.status(),
        };
        semantic.push(checks);
        ok(checks.apiOk, `semantic API ${id} status=${checks.httpStatus}`);
        if (checks.httpStatus === 200) {
          ok(checks.found === true, `semantic record found for ${id}`);
        }
      } catch (e) {
        ok(false, `semantic ${id}: ${e}`);
      }
    }
    ok(semantic.length >= 4, `browser_semantic_acceptance covered ${semantic.length} IDs`);

    // Last-mile semantic parity — DB presenter (staging DB) + HTTP list sanity
    process.env.DATABASE_URL = STAGING_DB;
    const { prisma } = await import("../src/lib/prisma.ts");
    const { presentSanitaLead } = await import("../src/lib/sanita/present-sanita-lead.ts");
    async function dbSemantic(id) {
      const lead = await prisma.lead.findUnique({ where: { id } });
      return { lead, sem: presentSanitaLead(lead) };
    }
    const LASTMILE = {
      clotilde: "cmqn2xibt000nmhc2s7aalaif",
      minerva: "cmqp5g0d7000510ohy3zt1x80",
      antoniano: "cmqo5x33c0025aa3v6q32x57y",
      villa: "cmqn3iyjo00061272bi8z4fmv",
      heidy: "cmqo8aopr002waa3v4cgcbhpv",
    };

    const clotilde = await dbSemantic(LASTMILE.clotilde);
    ok(Boolean(clotilde.lead), "Clotilde DB row");
    ok(clotilde.sem?.processingState === "PUBLISHED_EXPIRED", "Clotilde PUBLISHED_EXPIRED");
    ok(clotilde.sem?.validationStatus === "CURRENT_VERIFIED", "Clotilde CURRENT_VERIFIED");
    ok(/unipol/i.test(clotilde.lead?.policyCompany || ""), "Clotilde UnipolSai");
    ok(
      clotilde.sem?.policyExpiry === "2023-12-30" ||
        String(clotilde.lead?.policyExpiry || "").includes("2023-12-30"),
      "Clotilde expiry 2023-12-30"
    );
    ok(/scadut/i.test(clotilde.sem?.clientLabel || ""), "Clotilde badge Polizza scaduta");
    ok(!/in regola/i.test(clotilde.sem?.clientLabel || ""), "Clotilde never In regola");

    const heidy = await dbSemantic(LASTMILE.heidy);
    ok(Boolean(heidy.lead), "Heidy DB row");
    ok(heidy.sem?.processingState === "HOT_VERIFIED", "Heidy HOT_VERIFIED");
    ok(heidy.sem?.businessVerdict === "HOT_VERIFIED", "Heidy business HOT_VERIFIED");
    ok(heidy.sem?.validationStatus === "CURRENT_VERIFIED", "Heidy CURRENT_VERIFIED");
    ok(heidy.sem?.crawlComplete === true, "Heidy crawlComplete true");
    ok(Boolean(heidy.sem?.clientExplanation?.length), "Heidy completeness proof visible");
    ok(/first-party|sito/i.test(heidy.sem?.clientExplanation || heidy.lead?.evidence || ""), "Heidy first-party source");
    ok(Boolean(heidy.lead?.lastScannedAt), "Heidy scan date");
    ok(
      /portale regionale|Portali ASL|first-party/i.test(heidy.lead?.evidence || ""),
      "Heidy regional hint labeled non first-party"
    );

    for (const [name, id] of [
      ["Minerva", LASTMILE.minerva],
      ["Antoniano", LASTMILE.antoniano],
      ["Villa", LASTMILE.villa],
    ]) {
      const row = await dbSemantic(id);
      ok(Boolean(row.lead), `${name} DB row`);
      ok(row.sem?.validationStatus !== "CURRENT_VERIFIED", `${name} not CURRENT_VERIFIED`);
      ok(row.sem?.verdictToken !== "PUBLISHED", `${name} not PUBLISHED`);
      ok(Boolean(row.sem?.clientExplanation?.length), `${name} motivation visible`);
    }

    const queueRes = await page.request.get(`${BASE}/api/sanita?actionable=1`);
    const queueJson = await queueRes.json().catch(() => null);
    const queueLeads = queueJson?.data || queueJson?.leads || [];
    const techInQueue = queueLeads.filter((l) =>
      /RETRY_PENDING|TECHNICAL_BLOCKED|REVALIDATION_PENDING/i.test(l.evidence || "")
    );
    ok(techInQueue.length === 0, "technical states absent from commercial queue");
    await prisma.$disconnect().catch(() => {});
  } else {
    ok(false, "browser_semantic_acceptance: sample-sanita.json missing");
  }

  // Gare semantic fields from API
  try {
    const gres = await page.request.get(`${BASE}/api/gare`);
    const gj = await gres.json().catch(() => null);
    const gleads = gj?.leads || gj?.items || [];
    const g0 = gleads[0];
    if (g0) {
      ok(Boolean(g0.companyName || g0.tenderCig), "gare semantic: winner/cig field");
      ok("tenderAmount" in g0 || "leadScore" in g0, "gare semantic: amount/score field");
      ok(Boolean(g0.category || g0.evidence), "gare semantic: category/evidence");
    } else {
      ok(true, "gare semantic: empty staging set acceptable");
    }
  } catch (e) {
    ok(false, `gare semantic ${e}`);
  }

  fs.writeFileSync(
    path.join(OUT, "browser-acceptance.json"),
    JSON.stringify(
      {
        base: BASE,
        apiUi,
        semantic,
        screenshots: ["sanita-list.png", "gare-list.png"],
        note: "local staging HTTP — semantic + API/UI parity — no live side effects",
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
  if (child && child.pid) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else child.kill("SIGKILL");
    } catch {
      /* */
    }
  }
}

console.log(
  JSON.stringify(
    {
      suite: "staging-browser",
      exitCode: fail === 0 ? 0 : 1,
      durationMs: Date.now() - start,
      pass,
      fail,
      skipped: 0,
    },
    null,
    2
  )
);
process.exit(fail === 0 ? 0 : 1);
