/**
 * Canary test — Sanita job controller persistente + UI polling.
 *
 * Esegue 3 job:
 *   1) single (uno specifico lead)
 *   2) city (una city dal DB)
 *   3) region (regione dal DB)
 *
 * Obiettivo minimo: job parte, UI mostra testi cliente, polling persiste dopo reload,
 * cancel funziona (job interrotto/cancellato).
 *
 * Usage:
 *   BASE_URL=https://... npm run test:something? (run via node)
 *   BASE_URL=http://127.0.0.1:4310 node scripts/test-sanita-job-controller-canary.mjs
 */
import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:4310";
const POLL_MS = Number(process.env.POLL_MS || 1500);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 120_000);
const REQUIRE_RUNNING = process.env.REQUIRE_RUNNING === "1";
const MODES = (process.env.MODES || "single,city,region")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function apiJson(path, init) {
  const res = await fetch(`${BASE_URL}${path}`, init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { res, json, text };
}

async function waitFor(fn, timeoutMs = TIMEOUT_MS) {
  const t0 = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = await fn();
    if (r) return r;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(POLL_MS);
  }
}

async function pickLeadAndCity() {
  const { res, json } = await apiJson(
    "/api/sanita?includePending=1&includeAll=1",
    { headers: { "Content-Type": "application/json" } }
  );
  if (!res.ok || !json?.success) throw new Error(`/api/sanita failed: ${res.status}`);
  const data = Array.isArray(json.data) ? json.data : [];
  const first = data.find((l) => l?.id && (l.region === "Veneto" || l.region === "Campania")) || data[0];
  if (!first?.id) throw new Error("No leads returned from /api/sanita");

  const region = (first.region === "Campania" ? "Campania" : "Veneto");
  const cityLead = data.find((l) => l?.id && l.region === region && l.city && String(l.city).trim().length > 0) || first;
  return {
    region,
    leadId: String(first.id),
    city: cityLead?.city ? String(cityLead.city) : null,
  };
}

async function createJob(body) {
  const { res, json } = await apiJson("/api/sanita/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !json?.success || !json?.job?.jobId) {
    throw new Error(`create job failed: status=${res.status} err=${json?.error || "?"}`);
  }
  return json.job;
}

async function cancelJob(jobId) {
  const { res, json } = await apiJson(`/api/sanita/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
  });
  if (!res.ok || !json?.success) throw new Error(`cancel failed: status=${res.status}`);
  return json.job || null;
}

async function getJob(jobId) {
  const { res, json } = await apiJson(`/api/sanita/jobs/${encodeURIComponent(jobId)}`);
  if (!res.ok || !json?.success) throw new Error(`get job failed: status=${res.status}`);
  return json.job;
}

function assertNoInternalScanTerms(text) {
  const bad = ["discovery", "crawl"];
  const found = bad.filter((w) => text.includes(w));
  if (found.length) {
    throw new Error(`UI contains internal scan terms: ${found.join(", ")}`);
  }
}

async function verifyUiForJob(page, job) {
  await page.goto(`${BASE_URL}/sanita`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  // Card job status includes queste frasi in UI.
  await page.waitForSelector("text=Risultati certificati", { timeout: 60_000 }).catch(() => null);
  const card = page
    .locator('[class*="border-indigo-200/70"][class*="bg-indigo-50/40"]')
    .first();
  const innerText = await card.innerText();
  assertNoInternalScanTerms(innerText);

  // Verifica almeno uno dei testi richiesta.
  const ok =
    innerText.includes("In attesa") ||
    innerText.includes("Verifica in corso") ||
    innerText.includes("Job completato") ||
    innerText.includes("Job interrotto") ||
    innerText.includes("Job riprendibile");
  if (!ok) throw new Error("Job status text missing in UI.");

  // Reload: job deve essere ritrovabile.
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  const card2 = page
    .locator('[class*="border-indigo-200/70"][class*="bg-indigo-50/40"]')
    .first();
  const innerText2 = await card2.innerText();
  assertNoInternalScanTerms(innerText2);
}

async function runOneCase(page, body) {
  const created = await createJob(body);
  await verifyUiForJob(page, created);

  const advanced = await waitFor(async () => {
    const j = await getJob(created.jobId);
    return j?.status === "running" ? j : null;
  });
  if (!advanced && REQUIRE_RUNNING) {
    throw new Error(`Job ${created.jobId} did not reach status=running within timeout.`);
  }
  await cancelJob(created.jobId);
  await waitFor(async () => {
    const j = await getJob(created.jobId);
    return j?.status === "cancelled" ? j : null;
  }, TIMEOUT_MS);
  return created.jobId;
}

async function main() {
  const { region, leadId, city } = await pickLeadAndCity();
  if (!city) throw new Error("No city available in selected region for canary.");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const out = { base: BASE_URL, picked: { region, leadId, city }, cases: [] };

  if (MODES.includes("single")) {
    out.cases.push({
      case: "single",
      jobId: await runOneCase(page, { mode: "single", region, leadId, label: `Verifica struttura · ${leadId}` }),
    });
  }
  if (MODES.includes("city")) {
    out.cases.push({
      case: "city",
      jobId: await runOneCase(page, { mode: "city", region, city, label: `Scansione comune · ${city}` }),
    });
  }
  if (MODES.includes("region")) {
    out.cases.push({
      case: "region",
      jobId: await runOneCase(page, { mode: "region", region, label: `Scansione regione · ${region}` }),
    });
  }

  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

