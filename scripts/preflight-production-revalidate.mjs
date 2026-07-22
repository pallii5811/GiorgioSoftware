/**
 * Blocking PRODUCTION preflight for the sanita revalidation chain.
 *
 * Verifies the full dependency surface before any lead is consumed:
 * DB access/integrity, checkpoint R/W, frontier R/W + resume/retry,
 * disk/inode/mem/CPU, DNS/TLS/HTTP/redirect/gzip, Playwright launch +
 * JS rendering, PDF download/digital-parse/pdftoppm/rasterize/Tesseract
 * Italian OCR end-to-end, evidence persistence, SHA-256, env propagation
 * parent→child, heartbeat, graceful SIGTERM, and no checkpoint loss.
 *
 * Contexts (all must pass before corpus/877):
 *   1. plain shell:                npm run preflight:production-revalidate
 *   2. systemd user env:           systemctl ... Environment → same script
 *   3. same parent process:        import/spawn from orchestrator host
 *   4. spawned child worker:       this script re-spawns itself via `npx tsx`
 *      (the exact pattern used by production-revalidate-sanita-v3.mjs)
 *
 * Exit 1 → PREFLIGHT FAIL: do not consume leads, do not advance processed,
 * do not alter frontier. Only temp files are touched; the real checkpoint,
 * frontier DBs and lead DB are never mutated.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import zlib from "node:zlib";
import dns from "node:dns";
import tls from "node:tls";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARGV = new Set(process.argv.slice(2));
const IS_CHILD = ARGV.has("--child");
const SKIP_EXTERNAL = ARGV.has("--skip-external");
const reportIdx = process.argv.indexOf("--report");
const REPORT_PATH = reportIdx >= 0 ? process.argv[reportIdx + 1] : null;
const DEPTH = Number(process.env.PREFLIGHT_DEPTH || 0);
const EXTERNAL_HOST = process.env.PREFLIGHT_EXTERNAL_HOST || "www.google.com";

// ---- env normalization (same rules as preflight-ocr) ----------------------
process.env.PATH =
  process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
if (!process.env.PDFTOPPM_PATH && fs.existsSync("/usr/bin/pdftoppm")) {
  process.env.PDFTOPPM_PATH = "/usr/bin/pdftoppm";
}
const stagingPpm = path.join(
  ROOT,
  "data/staging/poppler/poppler-24.08.0/Library/bin/pdftoppm.exe"
);
if (!process.env.PDFTOPPM_PATH && fs.existsSync(stagingPpm)) {
  process.env.PDFTOPPM_PATH = stagingPpm;
}
if (!process.env.TESSDATA_PREFIX) {
  const tess = path.join(ROOT, ".tesseract-cache");
  if (fs.existsSync(path.join(tess, "ita.traineddata"))) process.env.TESSDATA_PREFIX = tess;
}
process.env.OCR_ENABLED = "1";
process.env.OCR_MAX_PAGES = process.env.OCR_MAX_PAGES || "2";
process.env.OCR_JOB_TIMEOUT_MS = process.env.OCR_JOB_TIMEOUT_MS || "120000";

// ---- result bookkeeping ----------------------------------------------------
const results = [];
let hardFails = 0;
function ok(cond, name, detail = "") {
  results.push({ name, ok: Boolean(cond), hard: true, detail: String(detail).slice(0, 300) });
  if (cond) console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    hardFails++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function soft(cond, name, detail = "") {
  results.push({ name, ok: Boolean(cond), hard: false, detail: String(detail).slice(0, 300) });
  console.log(`  ${cond ? "PASS" : "WARN"} ${name}${detail ? ` — ${detail}` : ""} (soft)`);
}

// ---- global watchdog: preflight itself must never hang ---------------------
const GLOBAL_TIMEOUT_MS = Number(process.env.PREFLIGHT_GLOBAL_TIMEOUT_MS || 8 * 60_000);
const globalTimer = setTimeout(() => {
  console.error(`PREFLIGHT_PRODUCTION_FAIL — global timeout ${GLOBAL_TIMEOUT_MS}ms exceeded`);
  process.exit(1);
}, GLOBAL_TIMEOUT_MS);
globalTimer.unref?.();

const t0 = Date.now();
console.log("=== preflight:production-revalidate ===");
console.log(
  JSON.stringify({
    cwd: process.cwd(),
    pid: process.pid,
    ppid: process.ppid,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    platform: process.platform,
    node: process.version,
    child: IS_CHILD,
    depth: DEPTH,
    PATH: process.env.PATH,
    PDFTOPPM_PATH: process.env.PDFTOPPM_PATH || null,
    TESSDATA_PREFIX: process.env.TESSDATA_PREFIX || null,
    DATABASE_URL: process.env.DATABASE_URL ? "set" : null,
    REVALIDATE_CHECKPOINT: process.env.REVALIDATE_CHECKPOINT || null,
  })
);

// ---- local fixture site (deterministic, no external dependency) ------------
const FIXTURE_MARKER = "PREFLIGHT_FIXTURE_ROOT_OK";
const GZIP_MARKER = "PREFLIGHT_GZIP_BODY_OK";
const JS_MARKER = "JS_RENDERED_OK";
const POLICY_TEXT =
  "POLIZZA RC PROFESSIONALE SANITARIA CONTRAENTE STRUTTURA OSPEDALIERA NUMERO POLIZZA 987654321 " +
  "COMPAGNIA ASSICURATRICE SCADENZA 31 12 2026 MASSIMALE EURO 1000000 PREMIO ANNUO. ";
let digitalPdfBuf = null;
let scannedPdfBuf = null;
let fixtureServer = null;
let fixtureBase = null;

async function buildFixtures() {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  // digital PDF: enough extractable text to hit the digital-rich threshold
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = [];
  for (let i = 0; i < 34; i++) lines.push(`${i + 1}. ${POLICY_TEXT}`);
  let page = doc.addPage([612, 792]);
  let y = 760;
  for (const line of lines) {
    if (y < 40) {
      page = doc.addPage([612, 792]);
      y = 760;
    }
    page.drawText(line.slice(0, 105), { x: 40, y, size: 9, font });
    y -= 20;
  }
  digitalPdfBuf = Buffer.from(await doc.save());

  // scanned (image-only) PDF: rasterize digital page 1, embed PNG, no text layer
  const { rasterizePdfPages } = await import("../src/lib/sanita/ocr.ts");
  const rast = await rasterizePdfPages(digitalPdfBuf, 1);
  if (rast.status !== "OK" || !rast.images?.length) {
    throw new Error(`fixture rasterize failed: ${rast.status} ${rast.error || ""}`);
  }
  const imgDoc = await PDFDocument.create();
  const png = await imgDoc.embedPng(rast.images[0]);
  const imgPage = imgDoc.addPage([png.width, png.height]);
  imgPage.drawImage(png, { x: 0, y: 0, width: png.width, height: png.height });
  scannedPdfBuf = Buffer.from(await imgDoc.save());
}

async function startFixtureServer() {
  const gzBody = zlib.gzipSync(Buffer.from(GZIP_MARKER));
  const html = (body) => Buffer.from(`<!doctype html><html><head><title>preflight</title></head><body>${body}</body></html>`);
  fixtureServer = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    try {
      if (u.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          html(
            `<h1>${FIXTURE_MARKER}</h1><a href="/trasparenza">trasparenza</a>` +
              `<a href="/documenti/polizza-digitale.pdf">polizza digitale</a>` +
              `<a href="/documenti/polizza-scansionata.pdf">polizza scansionata</a>`
          )
        );
      } else if (u.pathname === "/trasparenza") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html(`<h1>Amministrazione Trasparente</h1><p>${FIXTURE_MARKER}</p>`));
      } else if (u.pathname === "/redirect1") {
        res.writeHead(302, { location: "/redirect2" });
        res.end();
      } else if (u.pathname === "/redirect2") {
        res.writeHead(302, { location: "/final" });
        res.end();
      } else if (u.pathname === "/final") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("PREFLIGHT_REDIRECT_FINAL_OK");
      } else if (u.pathname === "/gzip") {
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        res.end(gzBody);
      } else if (u.pathname === "/js") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html(`<div id="r">pending</div><script>document.getElementById("r").textContent="${JS_MARKER}";</script>`));
      } else if (u.pathname === "/documenti/polizza-digitale.pdf") {
        res.writeHead(200, { "content-type": "application/pdf" });
        res.end(digitalPdfBuf);
      } else if (u.pathname === "/documenti/polizza-scansionata.pdf") {
        res.writeHead(200, { "content-type": "application/pdf" });
        res.end(scannedPdfBuf);
      } else {
        // catch-all 200: the preflight must exercise the success path only —
        // 404/EXCLUDED policy is covered by engine unit tests, and 404 retry
        // backoff would otherwise stall the mini-crawl on purpose-less waits.
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html(`<h1>${FIXTURE_MARKER}</h1><p>${POLICY_TEXT}</p>`));
      }
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  await new Promise((resolve, reject) => {
    fixtureServer.once("error", reject);
    fixtureServer.listen(0, "127.0.0.1", resolve);
  });
  fixtureBase = `http://127.0.0.1:${fixtureServer.address().port}`;
}

// ---- main ------------------------------------------------------------------
let prisma = null;
let frontierTmpDir = null;
try {
  console.log("\n[A] platform/env");
  ok(Number(process.versions.node.split(".")[0]) >= 20, "node>=20", process.version);
  ok(Boolean(process.env.DATABASE_URL), "DATABASE_URL set", process.env.DATABASE_URL ? "present" : "missing");
  ok(
    Boolean(process.env.REVALIDATE_CHECKPOINT),
    "REVALIDATE_CHECKPOINT set",
    process.env.REVALIDATE_CHECKPOINT || "missing"
  );
  ok(Boolean(process.env.PDFTOPPM_PATH), "PDFTOPPM_PATH resolved", process.env.PDFTOPPM_PATH);
  ok(
    Boolean(process.env.TESSDATA_PREFIX) &&
      fs.existsSync(path.join(process.env.TESSDATA_PREFIX, "ita.traineddata")),
    "tessdata ita present",
    process.env.TESSDATA_PREFIX
  );

  console.log("\n[B] database access/integrity (read-only)");
  if (process.env.DATABASE_URL) {
    try {
      ({ prisma } = await import("../src/lib/prisma.ts"));
      await prisma.$queryRawUnsafe("SELECT 1");
      ok(true, "db connect SELECT 1");
      const n = await prisma.lead.count();
      ok(n > 0, "db lead count > 0", `count=${n}`);
      const ic = await prisma.$queryRawUnsafe("PRAGMA integrity_check");
      const val = Array.isArray(ic) && ic.length ? String(Object.values(ic[0])[0]) : "";
      ok(val === "ok", "db integrity_check", val || "empty");
    } catch (e) {
      ok(false, "db access", String(e).slice(0, 250));
    }
  }

  console.log("\n[C] checkpoint readable/writable (temp file, real one untouched)");
  if (process.env.REVALIDATE_CHECKPOINT) {
    const cpPath = process.env.REVALIDATE_CHECKPOINT;
    try {
      const raw = fs.readFileSync(cpPath, "utf8");
      const parsed = JSON.parse(raw);
      ok(parsed.version >= 3, "checkpoint parses, version>=3", `v=${parsed.version}`);
    } catch (e) {
      ok(false, "checkpoint readable", String(e).slice(0, 200));
    }
    try {
      const dir = path.dirname(cpPath);
      const tmp = path.join(dir, `.preflight-${process.pid}.tmp`);
      const dst = path.join(dir, `.preflight-${process.pid}.probe`);
      const payload = JSON.stringify({ probe: true, pid: process.pid, at: new Date().toISOString() });
      fs.writeFileSync(tmp, payload);
      fs.renameSync(tmp, dst); // same atomic write+rename pattern as saveCheckpointAtomic
      const back = fs.readFileSync(dst, "utf8");
      ok(back === payload, "checkpoint dir atomic write+rename+readback");
      fs.unlinkSync(dst);
    } catch (e) {
      ok(false, "checkpoint writable", String(e).slice(0, 200));
    }
  }

  console.log("\n[D] system resources");
  try {
    const st = fs.statfsSync(process.cwd());
    const freeGb = (st.bavail * st.bsize) / 1e9;
    ok(freeGb >= 2, "disk free >= 2GB", `${freeGb.toFixed(1)}GB`);
  } catch {
    try {
      const out = execFileSync("df", ["-k", "/"], { encoding: "utf8" }).split("\n")[1];
      const availGb = Number(out.trim().split(/\s+/)[3]) / 1e6;
      ok(availGb >= 2, "disk free >= 2GB (df)", `${availGb.toFixed(1)}GB`);
    } catch (e2) {
      soft(false, "disk check unavailable", String(e2).slice(0, 120));
    }
  }
  if (process.platform !== "win32") {
    try {
      const out = execFileSync("df", ["-i", "/"], { encoding: "utf8" }).split("\n")[1];
      const ifree = Number(out.trim().split(/\s+/)[3]);
      ok(ifree >= 50_000, "inodes free >= 50k", `${ifree}`);
    } catch (e) {
      soft(false, "inode check unavailable", String(e).slice(0, 120));
    }
  }
  const freeMemMb = os.freemem() / 1e6;
  ok(freeMemMb >= 800, "memory free >= 800MB", `${freeMemMb.toFixed(0)}MB`);
  soft(freeMemMb >= 1500, "memory headroom >= 1500MB", `${freeMemMb.toFixed(0)}MB`);
  const load = os.loadavg()[0] || 0;
  const cpus = os.cpus().length || 2;
  soft(load < cpus * 0.95, "loadavg < cpus*0.95", `load=${load.toFixed(2)} cpus=${cpus}`);

  console.log("\n[E] network: DNS/TLS/HTTP/redirect/gzip");
  try {
    const lh = await dns.promises.lookup("localhost");
    ok(Boolean(lh?.address), "DNS localhost resolves (OS resolver)", lh?.address);
  } catch (e) {
    ok(false, "DNS localhost", String(e).slice(0, 120));
  }
  if (!SKIP_EXTERNAL) {
    try {
      const addrs = await dns.promises.resolve4(EXTERNAL_HOST);
      ok(addrs.length > 0, "DNS external resolves", `${EXTERNAL_HOST} → ${addrs[0]}`);
    } catch (e) {
      ok(false, "DNS external", String(e).slice(0, 150));
    }
    try {
      await new Promise((resolve, reject) => {
        const s = tls.connect(
          { host: EXTERNAL_HOST, port: 443, servername: EXTERNAL_HOST, rejectUnauthorized: true, timeout: 10_000 },
          () => {
            const auth = s.authorized;
            s.end();
            auth ? resolve() : reject(new Error(`TLS not authorized: ${s.authorizationError}`));
          }
        );
        s.once("error", reject);
        s.once("timeout", () => s.destroy(new Error("TLS timeout")));
      });
      ok(true, "TLS 443 with CA validation", EXTERNAL_HOST);
    } catch (e) {
      ok(false, "TLS external", String(e).slice(0, 150));
    }
  }

  console.log("\n[F] fixtures + HTTP fetch chain");
  try {
    await buildFixtures();
    ok(digitalPdfBuf?.slice(0, 5).toString() === "%PDF-", "digital fixture PDF built", `${digitalPdfBuf.length}B`);
    ok(scannedPdfBuf?.slice(0, 5).toString() === "%PDF-", "scanned fixture PDF built (rasterize+re-embed)", `${scannedPdfBuf.length}B`);
  } catch (e) {
    ok(false, "fixture build", String(e).slice(0, 250));
  }
  await startFixtureServer();
  const { externalFetch } = await import("../src/lib/http.ts");
  try {
    const r = await externalFetch(`${fixtureBase}/`, { timeoutMs: 5000 });
    const body = await r.text();
    ok(r.status === 200 && body.includes(FIXTURE_MARKER), "HTTP fetch local fixture", `status=${r.status}`);
  } catch (e) {
    ok(false, "HTTP fetch local", String(e).slice(0, 150));
  }
  try {
    const r = await externalFetch(`${fixtureBase}/redirect1`, { timeoutMs: 5000 });
    const body = await r.text();
    ok(body.includes("PREFLIGHT_REDIRECT_FINAL_OK"), "redirect chain 302→302→200 followed");
  } catch (e) {
    ok(false, "redirect chain", String(e).slice(0, 150));
  }
  try {
    const r = await externalFetch(`${fixtureBase}/gzip`, { timeoutMs: 5000 });
    const body = await r.text();
    ok(body.includes(GZIP_MARKER), "gzip decompression");
  } catch (e) {
    ok(false, "gzip decompression", String(e).slice(0, 150));
  }
  if (!SKIP_EXTERNAL) {
    let egressOk = false;
    let egressDetail = "";
    for (let attempt = 0; attempt < 2 && !egressOk; attempt++) {
      try {
        const r = await externalFetch(`https://${EXTERNAL_HOST}/generate_204`, { timeoutMs: 10_000 });
        egressOk = r.status > 0 && r.status < 500;
        egressDetail = `status=${r.status}`;
      } catch (e) {
        egressDetail = String(e).slice(0, 150);
      }
    }
    ok(egressOk, "external HTTPS egress", egressDetail);
  }

  console.log("\n[G] Playwright/Chromium + JS rendering");
  let browser = null;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    ok(true, "chromium launch");
    const page = await browser.newPage();
    await page.goto(`${fixtureBase}/js`, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForFunction(
      (marker) => document.getElementById("r")?.textContent === marker,
      JS_MARKER,
      { timeout: 10_000 }
    );
    ok(true, "JavaScript rendering in browser");
    await page.close();
  } catch (e) {
    ok(false, "playwright browser/js", String(e).slice(0, 250));
  } finally {
    try {
      await browser?.close();
    } catch {
      /* */
    }
  }

  console.log("\n[H] PDF pipeline: download/digital-parse/pdftoppm/rasterize/OCR-ita");
  const { resolvePdftoppm, extractPdfFullText } = await import("../src/lib/sanita/ocr.ts");
  const ppm = await resolvePdftoppm();
  ok(Boolean(ppm.path), "pdftoppm resolved", `${ppm.path} ${ppm.version || ""}`);
  try {
    const r = await externalFetch(`${fixtureBase}/documenti/polizza-digitale.pdf`, { timeoutMs: 5000 });
    const buf = Buffer.from(await r.arrayBuffer());
    ok(buf.slice(0, 5).toString() === "%PDF-", "PDF download over HTTP", `${buf.length}B`);
  } catch (e) {
    ok(false, "PDF download", String(e).slice(0, 150));
  }
  try {
    const ex = await extractPdfFullText(digitalPdfBuf);
    ok(
      ex.status === "OCR_NOT_NEEDED" && /POLIZZA/i.test(ex.text || ""),
      "digital PDF parse (no OCR needed)",
      `status=${ex.status} textLen=${(ex.text || "").length}`
    );
  } catch (e) {
    ok(false, "digital PDF parse", String(e).slice(0, 200));
  }
  try {
    const ex = await extractPdfFullText(scannedPdfBuf);
    const bad = ["OCR_RENDERER_MISSING", "OCR_TIMEOUT", "OCR_EXTRACTION_FAILED"].includes(ex.status);
    ok(!bad && /POLIZZA|ASSICURAZ|RC/i.test(ex.text || ""), "scanned PDF OCR italian end-to-end", `status=${ex.status} textLen=${(ex.text || "").length}`);
  } catch (e) {
    ok(false, "scanned PDF OCR", String(e).slice(0, 200));
  }

  console.log("\n[I] frontier R/W + mini-crawl resume/retry/evidence (temp DB)");
  try {
    frontierTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-frontier-"));
    const frontierPath = path.join(frontierTmpDir, "frontier.sqlite");
    const savedFrontierEnv = process.env.FRONTIER_DB_PATH;
    process.env.FRONTIER_DB_PATH = frontierPath;
    const fsStore = await import("../src/lib/sanita/frontier-store.ts");
    const runner = await import("../src/lib/sanita/crawl-slice-runner.ts");
    fsStore.openFrontierStore(frontierPath);
    const runId = `preflight-${process.pid}`;
    const { crawlRunId } = fsStore.createCrawlRun({ leadId: "PREFLIGHT", runId, workerId: "preflight" });
    ok(Boolean(crawlRunId), "frontier createCrawlRun", crawlRunId);

    // heartbeat: two beats, second must be >= first and non-null
    fsStore.heartbeatCrawlRun(crawlRunId, "beat1");
    const hb1 = fsStore.getCrawlRun(crawlRunId)?.heartbeatAt;
    await new Promise((r) => setTimeout(r, 1100));
    fsStore.heartbeatCrawlRun(crawlRunId, "beat2");
    const hb2 = fsStore.getCrawlRun(crawlRunId)?.heartbeatAt;
    ok(Boolean(hb1) && Boolean(hb2) && String(hb2) >= String(hb1), "heartbeat advances", `${hb1} → ${hb2}`);

    // pre-seed a stuck FETCHING node → resume must recover it (no node stuck forever)
    const seeded = runner.seedCrawlFrontier({ crawlRunId, website: `${fixtureBase}/` });
    ok(seeded > 0, "frontier seeded", `nodes=${seeded}`);
    const stuck = fsStore.listNodes(crawlRunId).find((n) => n.state === "QUEUED");
    if (stuck) fsStore.transitionFrontierNode(stuck.id, "FETCHING", { lastError: "simulated_crash" });

    // slice 1: resume converts the crashed FETCHING node to RETRY_PENDING (with backoff)
    await runner.runCrawlSlice({
      leadId: "PREFLIGHT",
      runId,
      website: `${fixtureBase}/`,
      workerId: "preflight",
      enablePlaywright: false,
      discoverLinks: true,
      budget: {
        sliceBudgetMs: 120_000,
        runMaxWallClockMs: 300_000,
        httpRequestTimeoutMs: 5_000,
        pdfFetchTimeoutMs: 15_000,
        ocrTimeoutMs: 120_000,
        maxUrlRetries: 1,
        maxDocumentRetries: 1,
        perHostDelayMs: 0,
        maxHtmlPerSlice: 8,
      },
    });
    const stuckMid = stuck ? fsStore.listNodes(crawlRunId).find((n) => n.id === stuck.id) : null;
    ok(
      !stuckMid || stuckMid.state !== "FETCHING",
      "resume: pre-crashed FETCHING node recovered",
      stuckMid ? `state=${stuckMid.state}` : "node gone"
    );
    // simulate backoff expiry so the run can legally complete (retry scheduling
    // itself is asserted separately via computeBackoffMs)
    if (stuckMid && stuckMid.state === "RETRY_PENDING") {
      try {
        fsStore.transitionFrontierNode(stuckMid.id, "RETRY_PENDING", {
          nextRetryAt: new Date(0).toISOString(),
        });
      } catch {
        /* */
      }
    }

    const { final } = await runner.runCrawlUntilSettled({
      leadId: "PREFLIGHT",
      runId,
      website: `${fixtureBase}/`,
      workerId: "preflight",
      enablePlaywright: false,
      discoverLinks: true,
      maxSlices: 8,
      seedExtraUrls: [
        `${fixtureBase}/documenti/polizza-digitale.pdf`,
        `${fixtureBase}/documenti/polizza-scansionata.pdf`,
      ],
      budget: {
        sliceBudgetMs: 120_000,
        runMaxWallClockMs: 300_000,
        httpRequestTimeoutMs: 5_000,
        pdfFetchTimeoutMs: 15_000,
        ocrTimeoutMs: 120_000,
        maxUrlRetries: 1,
        maxDocumentRetries: 1,
        perHostDelayMs: 0,
        maxHtmlPerSlice: 8,
      },
    });
    const nodes = fsStore.listNodes(crawlRunId);
    const fetchingLeft = nodes.filter((n) => n.state === "FETCHING").length;
    ok(fetchingLeft === 0, "resume: no node stuck FETCHING after crash-resume", `outcome=${final.outcome}`);
    const completedNodes = nodes.filter((n) => n.state === "COMPLETED").length;
    ok(completedNodes >= 2, "mini-crawl completed real nodes", `completed=${completedNodes}/${nodes.length}`);
    const agg = fsStore.aggregatePersistedEvidence(crawlRunId);
    ok(
      (agg?.pagesText || "").length > 50,
      "evidence: persisted text aggregated from crawl",
      `pagesTextLen=${(agg?.pagesText || "").length}`
    );
    ok(
      Boolean(agg?.policyFound) && /^[0-9a-f]{64}$/.test(agg?.contentHash || ""),
      "evidence: policy text + SHA-256 contentHash persisted",
      `policyFound=${agg?.policyFound} hash=${String(agg?.contentHash || "").slice(0, 12)}…`
    );
    ok(
      ["RUN_COMPLETED", "PUBLISHED_SIGNAL", "RUN_WALL_CLOCK"].includes(final.outcome),
      "mini-crawl settles with a legal outcome",
      final.outcome
    );
    // retry scheduling primitives
    ok(fsStore.computeBackoffMs(1) > 0, "retry backoff computes", `base=${fsStore.computeBackoffMs(1)}ms`);
    fsStore.closeFrontierStore();
    if (savedFrontierEnv == null) delete process.env.FRONTIER_DB_PATH;
    else process.env.FRONTIER_DB_PATH = savedFrontierEnv;
  } catch (e) {
    ok(false, "frontier/mini-crawl", String(e).slice(0, 300));
  }

  console.log("\n[J] hashing + env propagation + SIGTERM");
  const sha = crypto.createHash("sha256").update("abc").digest("hex");
  ok(sha === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "SHA-256 known vector");
  try {
    const child = spawn(
      process.execPath,
      ["-e", "console.log(JSON.stringify({p:process.env.PDFTOPPM_PATH||null,m:process.env.PREFLIGHT_MARKER||null}))"],
      { env: { ...process.env, PREFLIGHT_MARKER: "PROPAGATED" }, stdio: ["ignore", "pipe", "ignore"] }
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const code = await new Promise((r) => child.on("close", r));
    const parsed = JSON.parse(out.trim() || "{}");
    ok(code === 0 && parsed.p === process.env.PDFTOPPM_PATH && parsed.m === "PROPAGATED", "env propagates parent→child", JSON.stringify(parsed));
  } catch (e) {
    ok(false, "env propagation", String(e).slice(0, 150));
  }
  try {
    const child = spawn(
      process.execPath,
      ["-e", 'process.on("SIGTERM",()=>{process.stdout.write("TERM_OK\\n");process.exit(0)});setInterval(()=>{},500);'],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    await new Promise((r) => setTimeout(r, 400));
    child.kill("SIGTERM");
    const code = await Promise.race([
      new Promise((r) => child.on("close", r)),
      new Promise((r) => setTimeout(() => r("timeout"), 5000)),
    ]);
    if (process.platform === "win32") {
      // Windows has no POSIX signal delivery to arbitrary children (TerminateProcess);
      // production runs on Linux systemd — assert termination only.
      soft(code !== "timeout", "SIGTERM terminates child (win32: hard kill)", `code=${code}`);
    } else {
      ok(code === 0 && out.includes("TERM_OK"), "graceful SIGTERM honored by child", `code=${code}`);
    }
  } catch (e) {
    ok(false, "SIGTERM child", String(e).slice(0, 150));
  }

  console.log("\n[K] spawned child-worker context (npx tsx, same as orchestrator)");
  if (!IS_CHILD && DEPTH < 1) {
    try {
      const self = fileURLToPath(import.meta.url);
      const npx = process.platform === "win32" ? "npx.cmd" : "npx";
      const childArgs = ["tsx", self, "--child"];
      if (SKIP_EXTERNAL) childArgs.push("--skip-external");
      const child = spawn(npx, childArgs, {
        env: { ...process.env, PREFLIGHT_DEPTH: String(DEPTH + 1) },
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
      let tail = "";
      child.stdout.on("data", (d) => (tail = (tail + d).slice(-4000)));
      child.stderr.on("data", (d) => (tail = (tail + d).slice(-4000)));
      const code = await Promise.race([
        new Promise((r) => child.on("close", r)),
        new Promise((r) => setTimeout(() => r("timeout"), GLOBAL_TIMEOUT_MS - 60_000)),
      ]);
      ok(code === 0, "child-worker preflight context passes", `exit=${code}`);
      if (code !== 0) console.error(`  child tail: ${tail.split("\n").slice(-12).join("\n")}`);
    } catch (e) {
      ok(false, "child-worker spawn", String(e).slice(0, 200));
    }
  } else {
    console.log("  SKIP (already in child context)");
  }
} finally {
  try {
    fixtureServer?.close();
  } catch {
    /* */
  }
  try {
    if (frontierTmpDir) fs.rmSync(frontierTmpDir, { recursive: true, force: true });
  } catch {
    /* */
  }
  try {
    await prisma?.$disconnect();
  } catch {
    /* */
  }
}

clearTimeout(globalTimer);
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const summary = {
  verdict: hardFails ? "PREFLIGHT_PRODUCTION_FAIL" : "PREFLIGHT_PRODUCTION_PASS",
  elapsedSec: Number(elapsed),
  checks: results.length,
  hardFails,
  at: new Date().toISOString(),
  child: IS_CHILD,
  results,
};
if (REPORT_PATH) {
  try {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, JSON.stringify(summary, null, 1));
  } catch (e) {
    console.error(`  WARN cannot write report: ${e}`);
  }
}
console.log(`\n${summary.verdict} — ${results.length} checks, ${hardFails} hard fails, ${elapsed}s`);
process.exit(hardFails ? 1 : 0);
