/**
 * Regression tests for k3 resilience patches (RC-01..RC-05):
 *  - RC-01 circuit breaker: DNS-dead host → fast block, no refetch storm, no false terminal
 *  - RC-02 403/429 → per-node browser escalation
 *  - RC-03 stall watchdog: hanging fetch → NODE_STALL_WATCHDOG, recoverable
 *  - RC-04 worker SIGTERM handler present (static contract; E2E in corpus)
 *  - RC-05 policy-playwright call-time budget (static contract)
 * Run: npx tsx scripts/test-crawl-resilience.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.OCR_ENABLED = "1";
process.env.OCR_MAX_PAGES = "1";
process.env.OCR_JOB_TIMEOUT_MS = process.env.OCR_JOB_TIMEOUT_MS || "60000";
if (!process.env.PDFTOPPM_PATH) {
  for (const c of [
    "/usr/bin/pdftoppm",
    path.join(ROOT, "data/staging/poppler/poppler-24.08.0/Library/bin/pdftoppm.exe"),
  ]) {
    if (fs.existsSync(c)) {
      process.env.PDFTOPPM_PATH = c;
      break;
    }
  }
}
if (!process.env.TESSDATA_PREFIX) {
  const t = path.join(ROOT, ".tesseract-cache");
  if (fs.existsSync(path.join(t, "ita.traineddata"))) process.env.TESSDATA_PREFIX = t;
}

let n = 0;
function t(name, fn) {
  n++;
  return Promise.resolve()
    .then(fn)
    .then(
      () => console.log(`  PASS ${n}. ${name}`),
      (e) => {
        console.error(`  FAIL ${n}. ${name}\n    ${String(e?.message || e).slice(0, 400)}`);
        process.exitCode = 1;
      }
    );
}

async function withFrontier(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "k3-resil-"));
  const fp = path.join(tmp, "frontier.sqlite");
  const saved = process.env.FRONTIER_DB_PATH;
  process.env.FRONTIER_DB_PATH = fp;
  const fsStore = await import("../src/lib/sanita/frontier-store.ts");
  const runner = await import("../src/lib/sanita/crawl-slice-runner.ts");
  fsStore.openFrontierStore(fp);
  try {
    return await fn({ fsStore, runner });
  } finally {
    try {
      fsStore.closeFrontierStore();
    } catch {
      /* */
    }
    if (saved == null) delete process.env.FRONTIER_DB_PATH;
    else process.env.FRONTIER_DB_PATH = saved;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
}

console.log("=== test: crawl-resilience (k3 RC-01..RC-05) ===");

// ---------------------------------------------------------------- RC-01
await t("RC-01 circuit breaker: host DNS-morto → block rapido senza tempesta di refetch", async () => {
  const deadSite = "http://k3-host-inesistente.invalid/";
  const t0 = Date.now();
  const r = await withFrontier(async ({ fsStore, runner }) => {
    const { crawlRunId } = fsStore.createCrawlRun({ leadId: "RC01", runId: "rc01", workerId: "t" });
    const out = await runner.runCrawlUntilSettled({
      leadId: "RC01",
      runId: "rc01",
      website: deadSite,
      workerId: "t",
      enablePlaywright: false,
      discoverLinks: false,
      maxSlices: 6,
      budget: {
        sliceBudgetMs: 60_000,
        runMaxWallClockMs: 120_000,
        httpRequestTimeoutMs: 8_000,
        maxUrlRetries: 3,
        perHostDelayMs: 0,
        maxHtmlPerSlice: 10,
      },
    });
    const nodes = fsStore.listNodes(crawlRunId);
    const blocked = nodes.filter((x) => x.state === "TECHNICAL_BLOCKED");
    const circuit = blocked.filter((x) => /^host_circuit_open@\d+/.test(x.lastError || ""));
    return { final: out.final, nodes, blocked, circuit, crawlRunId, fsStore };
  });
  const wall = Date.now() - t0;
  assert.ok(wall < 90_000, `wall ${wall}ms deve essere < 90s (era 30 minuti / 98 retry)`);
  assert.ok(r.circuit.length >= 1, `circuito deve risultare aperto: ${JSON.stringify(r.nodes.map((x) => [x.state, x.lastError]))}`);
  // nessun nodo deve avere retryCount assurdo (vecchio comportamento: 94-98)
  const maxRetry = Math.max(...r.nodes.map((x) => x.retryCount || 0));
  assert.ok(maxRetry <= 8, `retryCount max ${maxRetry} deve restare basso`);
  // seconda run (resume): i nodi circuit-open NON vengono riaperti → zero fetch
  const t1 = Date.now();
  await withFrontier(async ({ fsStore, runner }) => {
    // riuso STESSO runId/frontier? No: withFrontier nuovo DB — la resume-skip è
    // testata staticamente sotto; qui basta che il primo run sia rapido.
  });
  assert.ok(Date.now() - t1 < 10_000);
});

await t("RC-01b resume: nodi host_circuit_open NON riaperti prima di REPROBE_MS", async () => {
  await withFrontier(async ({ fsStore, runner }) => {
    const { crawlRunId } = fsStore.createCrawlRun({ leadId: "RC01B", runId: "rc01b", workerId: "t" });
    runner.seedCrawlFrontier({ crawlRunId, website: "http://k3-host-inesistente.invalid/" });
    const nodes = fsStore.listNodes(crawlRunId);
    for (const x of nodes.slice(0, 3)) {
      // path FSM legale: QUEUED → FETCHING → TECHNICAL_BLOCKED
      fsStore.transitionFrontierNode(x.id, "FETCHING", {});
      fsStore.transitionFrontierNode(x.id, "TECHNICAL_BLOCKED", {
        lastError: `host_circuit_open@${Date.now()}:simulated`,
        bumpRetry: true,
      });
    }
    // resume = nuovo slice sullo stesso runId: i 3 nodi devono RESTARE bloccati
    const slice = await runner.runCrawlSlice({
      leadId: "RC01B",
      runId: "rc01b",
      website: "http://k3-host-inesistente.invalid/",
      workerId: "t",
      enablePlaywright: false,
      discoverLinks: false,
      budget: { sliceBudgetMs: 10_000, runMaxWallClockMs: 30_000, httpRequestTimeoutMs: 5_000, perHostDelayMs: 0, maxHtmlPerSlice: 5 },
    });
    const after = fsStore.listNodes(crawlRunId);
    const stillBlocked = after.filter((x) => /^host_circuit_open@\d+/.test(x.lastError || "") && x.state === "TECHNICAL_BLOCKED");
    assert.ok(stillBlocked.length >= 3, `nodi circuit-open riaperti indebitamente: ${after.map((x) => [x.state, x.lastError]).join("|")}`);
    assert.ok(slice.wallMs < 60_000);
  });
});

// ---------------------------------------------------------------- RC-02
await t("RC-02 escalation browser: 403 via HTTP → 200 via browser → nodo COMPLETED", async () => {
  const POLICY = "POLIZZA RCT STRUTTURA SANITARIA NUMERO 777 SCADENZA 31/12/2026 COMPAGNIA TEST MASSIMALE";
  const server = http.createServer((req, res) => {
    const ua = String(req.headers["user-agent"] || "");
    const isBrowser = /Chrome\/\d+/i.test(ua) && !/undici|node/i.test(ua);
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body><a href="/download">download</a></body></html>`);
      return;
    }
    if (req.url === "/download") {
      if (!isBrowser) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("WAF blocked");
      } else {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><body><h1>${POLICY}</h1></body></html>`);
      }
      return;
    }
    res.writeHead(404);
    res.end("nf");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await withFrontier(async ({ fsStore, runner }) => {
      const { crawlRunId } = fsStore.createCrawlRun({ leadId: "RC02", runId: "rc02", workerId: "t" });
      runner.seedCrawlFrontier({ crawlRunId, website: `${base}/`, extraUrls: [`${base}/download`] });
      const out = await runner.runCrawlUntilSettled({
        leadId: "RC02",
        runId: "rc02",
        website: `${base}/`,
        workerId: "t",
        enablePlaywright: false,
        discoverLinks: true,
        maxSlices: 6,
        budget: { sliceBudgetMs: 60_000, runMaxWallClockMs: 120_000, httpRequestTimeoutMs: 5_000, maxUrlRetries: 1, perHostDelayMs: 0, maxHtmlPerSlice: 10 },
      });
      const nodes = fsStore.listNodes(crawlRunId);
      const dl = nodes.find((x) => /\/download$/.test(x.canonicalUrl));
      assert.ok(dl, "nodo /download assente");
      assert.equal(dl.state, "COMPLETED", `/download deve completarsi via browser escalation (era TECHNICAL_BLOCKED http_403), ora: ${dl.state} err=${dl.lastError}`);
      const agg = fsStore.aggregatePersistedEvidence(crawlRunId);
      assert.ok(/POLIZZA RCT/i.test(agg.pagesText + " " + (agg.policyText || "")), "contenuto browser persistito come evidence");
    });
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------- RC-03
await t("RC-03 stall watchdog: fetch appeso → NODE_STALL_WATCHDOG, run ferma in fretta", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/hang") {
      setTimeout(() => {
        try {
          res.writeHead(200, { "content-type": "text/html" });
          res.end("<html><body>late</body></html>");
        } catch {
          /* */
        }
      }, 30_000);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>ok</body></html>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const prevStall = process.env.CRAWL_NODE_STALL_MS;
  process.env.CRAWL_NODE_STALL_MS = "3000";
  try {
    await withFrontier(async ({ fsStore, runner }) => {
      const { crawlRunId } = fsStore.createCrawlRun({ leadId: "RC03", runId: "rc03", workerId: "t" });
      const t0 = Date.now();
      const slice = await runner.runCrawlSlice({
        leadId: "RC03",
        runId: "rc03",
        website: `${base}/`,
        workerId: "t",
        enablePlaywright: false,
        discoverLinks: false,
        seedExtraUrls: [`${base}/hang`],
        budget: { sliceBudgetMs: 60_000, runMaxWallClockMs: 90_000, httpRequestTimeoutMs: 25_000, maxUrlRetries: 1, perHostDelayMs: 0, maxHtmlPerSlice: 20 },
      });
      const wall = Date.now() - t0;
      assert.equal(slice.stopReason, "NODE_STALL_WATCHDOG", `stopReason=${slice.stopReason}`);
      assert.ok(wall < 25_000, `wall ${wall}ms — il watchdog deve fermare prima del timeout fetch 25s`);
      // nodo /hang mai terminale: resta recuperabile
      const hang = fsStore.listNodes(crawlRunId).find((x) => /\/hang$/.test(x.canonicalUrl));
      assert.ok(hang && !["COMPLETED", "EXCLUDED"].includes(hang.state), `/hang state=${hang?.state}`);
    });
  } finally {
    if (prevStall == null) delete process.env.CRAWL_NODE_STALL_MS;
    else process.env.CRAWL_NODE_STALL_MS = prevStall;
    server.close();
  }
});

// ---------------------------------------------------------------- RC-04/05 (static contracts)
await t("RC-04 worker: handler SIGTERM graceful presente e scrive riga risultato", async () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts/production-revalidate-sanita-worker.mjs"), "utf8");
  assert.ok(/process\.on\("SIGTERM"/.test(src), "handler SIGTERM assente");
  assert.ok(/WORKER_SIGTERM/.test(src), "riga risultato WORKER_SIGTERM assente");
  assert.ok(/writeResultAtomic\(outPath, row\)/.test(src), "scrittura atomica risultato assente nel handler");
});

await t("RC-05 policy-playwright: budget call-time, nessun goto 45s hardcoded", async () => {
  const src = fs.readFileSync(path.join(ROOT, "src/lib/sanita/policy-playwright.ts"), "utf8");
  assert.ok(!/timeout:\s*45_000/.test(src), "goto timeout 45s hardcoded ancora presente");
  assert.ok(/function policyMaxMs\(\)/.test(src) && /policyMaxMs\(\)/.test(src), "budget non letto a call-time");
  assert.ok(/const maxMs = policyMaxMs\(\)/.test(src), "maxMs non usa policyMaxMs()");
});

await t("RC-01c runner: watchdog + circuit configurabili via env (static contract)", async () => {
  const src = fs.readFileSync(path.join(ROOT, "src/lib/sanita/crawl-slice-runner.ts"), "utf8");
  assert.ok(/CRAWL_NODE_STALL_MS/.test(src));
  assert.ok(/CRAWL_HOST_CIRCUIT_THRESHOLD/.test(src));
  assert.ok(/CRAWL_HOST_CIRCUIT_REPROBE_MS/.test(src));
  assert.ok(/CRAWL_BROWSER_ESCALATION/.test(src));
});

console.log(`\n${n} tests, exit=${process.exitCode || 0}`);
process.exit(process.exitCode || 0);
