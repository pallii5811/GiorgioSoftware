/**
 * Positive apply E2E — Malzoni (PUBLISHED, force rescan) via jobs API.
 * Run on Hetzner blue or Preview (proxied):
 *   BASE_URL=http://168.119.253.47:3000 node scripts/test-sanita-positive-apply-e2e.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BASE_URL = (process.env.BASE_URL || "http://168.119.253.47:3000").replace(/\/$/, "");
const LEAD_ID = process.env.APPLY_LEAD_ID || "cmqktyimz000i111hygme29nh";
const LEAD_NAME = process.env.APPLY_LEAD_NAME || "Malzoni";
const TIMEOUT_MS = Number(process.env.APPLY_TIMEOUT_MS || 900_000);
const POLL_MS = 5000;

function verifyAuditOnServer(jobId, leadId) {
  const out = execFileSync(
    "node",
    [
      "scripts/verify-sanita-gate-hetzner.mjs",
      `--jobId=${jobId}`,
      `--leadId=${leadId}`,
      "--requireAudit=1",
      "--failOnError=1",
    ],
    { encoding: "utf8", cwd: process.cwd() }
  );
  const line = out.trim().split("\n").pop();
  const parsed = JSON.parse(line);
  return Boolean(parsed.auditExists);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function api(path, init) {
  const res = await fetch(`${BASE_URL}${path}`, init);
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

async function countActionable() {
  const r = await api("/api/sanita?region=Campania&includeAll=1");
  const data = r.json?.data || [];
  return data.filter((l) => l._actionable || /\[BV:PUBLISHED/.test(l.evidence || "")).length;
}

async function main() {
  const beforeRes = await api(`/api/sanita?region=Campania&includeAll=1`);
  const beforeLead = (beforeRes.json?.data || []).find((l) => l.id === LEAD_ID);
  if (!beforeLead) throw new Error(`Lead ${LEAD_ID} not found`);
  const crmBefore = { status: beforeLead.status, notes: beforeLead.notes || "" };
  const evidenceBefore = beforeLead.evidence || "";
  const scannedBefore = beforeLead.lastScannedAt;
  const actionableBefore = await countActionable();

  const created = await api("/api/sanita/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "single",
      region: "Campania",
      leadId: LEAD_ID,
      forceRescan: true,
    }),
  });
  if (!created.ok || !created.json?.job?.jobId) {
    throw new Error(`create job failed: ${created.status} ${JSON.stringify(created.json)}`);
  }
  const jobId = created.json.job.jobId;

  const t0 = Date.now();
  let final = null;
  while (Date.now() - t0 < TIMEOUT_MS) {
    const j = await api(`/api/sanita/jobs/${jobId}`);
    final = j.json?.job;
    if (final?.status === "completed" || final?.status === "failed" || final?.status === "cancelled") {
      break;
    }
    await sleep(POLL_MS);
  }
  if (!final) throw new Error("job timeout");

  const afterRes = await api(`/api/sanita?region=Campania&includeAll=1`);
  const afterLead = (afterRes.json?.data || []).find((l) => l.id === LEAD_ID);
  const crmAfter = { status: afterLead?.status, notes: afterLead?.notes || "" };
  const evidenceAfter = afterLead?.evidence || "";
  const actionableAfter = await countActionable();

  const applyAuditExists = await verifyAuditOnServer(jobId, LEAD_ID);

  const report = {
    jobId,
    leadId: LEAD_ID,
    leadName: beforeLead.companyName,
    durationMs: Date.now() - t0,
    finalStatus: final.status,
    certifiedResults: final.progress?.certifiedResults,
    scannedBefore,
    scannedAfter: afterLead?.lastScannedAt,
    evidenceChanged: evidenceBefore !== evidenceAfter,
    crmBefore,
    crmAfter,
    crmPreserved:
      crmBefore.status === crmAfter.status && crmBefore.notes === crmAfter.notes,
    actionableBefore,
    actionableAfter,
    applyAuditExists,
    pass:
      final.status === "completed" &&
      (final.progress?.certifiedResults || 0) >= 1 &&
      evidenceBefore !== evidenceAfter &&
      crmBefore.status === crmAfter.status &&
      crmBefore.notes === crmAfter.notes &&
      applyAuditExists,
  };

  const outDir = process.env.OUT_DIR || "data/positive-apply-e2e";
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
