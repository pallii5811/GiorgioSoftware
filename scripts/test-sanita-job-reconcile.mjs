/**
 * Deterministic reconcile tests — zombie queued+pid, PID reuse, locks, checkpoint.
 * Run: npx tsx scripts/test-sanita-job-reconcile.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  reconcileOneSanitaJob,
  reconcileStaleSanitaJobs,
  SANITA_JOB_QUEUED_PID_GRACE_MS,
  SANITA_JOB_STALE_MS,
} from "../src/lib/sanita/job-watchdog.ts";
import {
  emptySanitaJob,
  writeSanitaJob,
  readSanitaJob,
  findActiveJobByTarget,
  isActiveSanitaJob,
} from "../src/lib/sanita/jobs.ts";
import {
  acquireJobTargetLock,
  readJobTargetLock,
  releaseJobTargetLock,
} from "../src/lib/sanita/job-target-lock.ts";

const MALZONI_JOB_ID = "12b9eb87-3f51-4b7a-92b8-025477c8e34c";
const MALZONI_LEAD_ID = "cmqktyimz000i111hygme29nh";

let failed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`PASS ${name}`))
    .catch((e) => {
      failed++;
      console.error(`FAIL ${name}:`, e.message);
    });
}

const prevCwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sanita-reconcile-"));
process.chdir(tmp);
fs.mkdirSync("data/sanita-jobs", { recursive: true });

function writeCheckpoint(jobId, leadId) {
  const ns = path.join("data", "sanita-jobs", jobId);
  fs.mkdirSync(ns, { recursive: true });
  const payload = { jobId, leadId, checkpoint: true, ts: "baseline" };
  fs.writeFileSync(path.join(ns, "checkpoint.json"), JSON.stringify(payload, null, 2));
  return payload;
}

function readCheckpoint(jobId) {
  const file = path.join("data", "sanita-jobs", jobId, "checkpoint.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function seedJob(overrides = {}) {
  const jobId = overrides.jobId || crypto.randomUUID();
  const base = emptySanitaJob({
    jobId,
    mode: overrides.mode || "single",
    region: "Campania",
    leadId: overrides.leadId || "lead-1",
  });
  const job = {
    ...base,
    ...overrides,
    progress: { ...base.progress, ...(overrides.progress || {}) },
  };
  writeSanitaJob(job);
  if (overrides.lastHeartbeatAt || overrides.updatedAt) {
    const file = path.join("data/sanita-jobs", `${jobId}.json`);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (overrides.lastHeartbeatAt) saved.lastHeartbeatAt = overrides.lastHeartbeatAt;
    if (overrides.updatedAt) saved.updatedAt = overrides.updatedAt;
    fs.writeFileSync(file, JSON.stringify(saved, null, 2));
  }
  if (overrides.withCheckpoint) writeCheckpoint(jobId, job.leadId);
  if (overrides.acquireLock) acquireJobTargetLock(job.targetKey, job.jobId, job.pid ?? null);
  return readSanitaJob(jobId);
}

const deadPid = 9_999_991;
const foreignPid = 9_999_992;
const validPid = 9_999_993;
let killed = [];

const deps = {
  isProcessAlive: (pid) => pid === validPid || pid === foreignPid,
  readCmdline: (pid) => {
    if (pid === validPid) return `node tsx scripts/sanita-job-runner.mjs job-valid`;
    if (pid === foreignPid) return `nginx: worker process`;
    return null;
  },
  killProcessControlled: (pid) => {
    killed.push(pid);
  },
};

try {
  await check("1_queued_pid_absent_reconciled", () => {
    const now = Date.now();
    const job = seedJob({
      status: "queued",
      pid: deadPid,
      updatedAt: new Date(now - SANITA_JOB_QUEUED_PID_GRACE_MS - 1000).toISOString(),
      lastHeartbeatAt: new Date(now - SANITA_JOB_STALE_MS - 1000).toISOString(),
      acquireLock: true,
    });
    const out = reconcileOneSanitaJob(job, now, deps);
    assert.equal(out.action, "reconciled");
    const after = readSanitaJob(job.jobId);
    assert.equal(after.status, "failed");
    assert.equal(after.pid, null);
    assert.equal(readJobTargetLock(job.targetKey), null);
  });

  await check("2_running_pid_absent_reconciled", () => {
    const now = Date.now();
    const job = seedJob({
      status: "running",
      pid: deadPid,
      lastHeartbeatAt: new Date(now - 1000).toISOString(),
    });
    const out = reconcileOneSanitaJob(job, now, deps);
    assert.equal(out.action, "reconciled");
    assert.equal(readSanitaJob(job.jobId).status, "failed");
  });

  await check("3_queued_foreign_pid_not_killed", () => {
    killed = [];
    const now = Date.now();
    const job = seedJob({
      jobId: "foreign-job",
      status: "queued",
      pid: foreignPid,
      updatedAt: new Date(now - SANITA_JOB_QUEUED_PID_GRACE_MS - 1000).toISOString(),
      lastHeartbeatAt: new Date(now - SANITA_JOB_STALE_MS - 1000).toISOString(),
    });
    const out = reconcileOneSanitaJob(job, now, deps);
    assert.equal(out.reason, "pid_foreign");
    assert.equal(killed.length, 0);
    assert.equal(readSanitaJob(job.jobId).pid, null);
  });

  await check("4_valid_runner_recent_heartbeat_unchanged", () => {
    const now = Date.now();
    const jobId = "job-valid";
    const job = seedJob({
      jobId,
      status: "running",
      pid: validPid,
      lastHeartbeatAt: new Date(now - 5000).toISOString(),
    });
    const localDeps = {
      ...deps,
      readCmdline: (pid) =>
        pid === validPid ? `node tsx scripts/sanita-job-runner.mjs ${jobId}` : null,
    };
    const out = reconcileOneSanitaJob(job, now, localDeps);
    assert.equal(out.action, "unchanged");
    assert.equal(readSanitaJob(jobId).status, "running");
  });

  await check("5_valid_runner_stale_terminated", () => {
    killed = [];
    const now = Date.now();
    const jobId = "job-stale";
    const job = seedJob({
      jobId,
      status: "running",
      pid: validPid,
      lastHeartbeatAt: new Date(now - SANITA_JOB_STALE_MS - 5000).toISOString(),
    });
    const localDeps = {
      ...deps,
      readCmdline: (pid) =>
        pid === validPid ? `node tsx scripts/sanita-job-runner.mjs ${jobId}` : null,
    };
    const out = reconcileOneSanitaJob(job, now, localDeps);
    assert.equal(out.action, "reconciled");
    assert.equal(out.killed, true);
    assert.ok(killed.includes(validPid));
    assert.equal(readSanitaJob(jobId).pid, null);
  });

  await check("6_lock_other_job_not_removed", () => {
    const targetKey = "single:lock-test";
    acquireJobTargetLock(targetKey, "owner-job", 111);
    const released = releaseJobTargetLock(targetKey, "other-job");
    assert.equal(released, false);
    assert.equal(readJobTargetLock(targetKey)?.jobId, "owner-job");
    releaseJobTargetLock(targetKey, "owner-job");
  });

  await check("7_zombie_lock_removed", () => {
    const now = Date.now();
    const job = seedJob({
      status: "queued",
      pid: deadPid,
      updatedAt: new Date(now - SANITA_JOB_QUEUED_PID_GRACE_MS - 1000).toISOString(),
      lastHeartbeatAt: new Date(now - SANITA_JOB_STALE_MS - 1000).toISOString(),
      acquireLock: true,
    });
    assert.ok(readJobTargetLock(job.targetKey));
    reconcileOneSanitaJob(job, now, deps);
    assert.equal(readJobTargetLock(job.targetKey), null);
  });

  await check("8_checkpoint_preserved", () => {
    const now = Date.now();
    const job = seedJob({
      status: "running",
      pid: deadPid,
      withCheckpoint: true,
      lastHeartbeatAt: new Date(now - 1000).toISOString(),
    });
    const before = readCheckpoint(job.jobId);
    reconcileOneSanitaJob(job, now, deps);
    const after = readCheckpoint(job.jobId);
    assert.equal(after.checkpoint, before.checkpoint);
    assert.equal(after.ts, "baseline");
  });

  await check("9_same_target_restartable", () => {
    const now = Date.now();
    const job = seedJob({
      leadId: "restart-lead",
      status: "queued",
      pid: deadPid,
      updatedAt: new Date(now - SANITA_JOB_QUEUED_PID_GRACE_MS - 1000).toISOString(),
      lastHeartbeatAt: new Date(now - SANITA_JOB_STALE_MS - 1000).toISOString(),
    });
    reconcileOneSanitaJob(job, now, deps);
    assert.equal(findActiveJobByTarget(job.targetKey), null);
    const next = emptySanitaJob({
      jobId: "new-job",
      mode: "single",
      region: "Campania",
      leadId: "restart-lead",
    });
    writeSanitaJob(next);
    assert.ok(isActiveSanitaJob(readSanitaJob("new-job")));
  });

  await check("10_technical_job_never_actionable", () => {
    const now = Date.now();
    const job = seedJob({
      status: "running",
      pid: deadPid,
      progress: { certifiedResults: 0, currentMessage: "x" },
      lastHeartbeatAt: new Date(now - 1000).toISOString(),
    });
    reconcileOneSanitaJob(job, now, deps);
    const after = readSanitaJob(job.jobId);
    assert.equal(after.progress.certifiedResults, 0);
    assert.equal(after.lastUpdateLabel, "Verifica non completata");
  });

  await check("11_no_zombie_process_left", () => {
    killed = [];
    const now = Date.now();
    seedJob({
      jobId: "z1",
      status: "queued",
      pid: deadPid,
      updatedAt: new Date(now - SANITA_JOB_QUEUED_PID_GRACE_MS - 1000).toISOString(),
      lastHeartbeatAt: new Date(now - SANITA_JOB_STALE_MS - 1000).toISOString(),
    });
    seedJob({
      jobId: "z2",
      status: "running",
      pid: deadPid,
      lastHeartbeatAt: new Date(now - 1000).toISOString(),
    });
    reconcileStaleSanitaJobs(now, deps);
    assert.equal(killed.length, 0);
  });

  await check("12_no_job_stays_queued_running_after_reconcile", () => {
    const now = Date.now();
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const jobId = `bulk-${i}`;
      ids.push(jobId);
      seedJob({
        jobId,
        status: i % 2 === 0 ? "queued" : "running",
        pid: deadPid,
        updatedAt: new Date(now - SANITA_JOB_QUEUED_PID_GRACE_MS - 2000).toISOString(),
        lastHeartbeatAt: new Date(now - SANITA_JOB_STALE_MS - 2000).toISOString(),
      });
    }
    reconcileStaleSanitaJobs(now, deps);
    const left = ids
      .map((id) => readSanitaJob(id))
      .filter((j) => j && (j.status === "queued" || j.status === "running"));
    assert.equal(left.length, 0);
  });

  await check("regression_12b9eb87_malzoni_queued_pid", () => {
    const now = Date.parse("2026-07-21T13:25:00.000Z");
    const job = seedJob({
      jobId: MALZONI_JOB_ID,
      leadId: MALZONI_LEAD_ID,
      status: "queued",
      pid: 4123456,
      createdAt: "2026-07-21T13:10:00.000Z",
      updatedAt: "2026-07-21T13:10:05.000Z",
      lastHeartbeatAt: "2026-07-21T13:10:00.000Z",
      progress: {
        structuresControlled: 0,
        totalStructures: 1,
        certifiedResults: 0,
        autoVerificationsPending: 0,
        manualChecksNeeded: 0,
        percent: 0,
        currentMessage: "Job in coda.",
        currentStructure: "Casa Di Cura Malzoni Villa Platani Spa",
      },
      acquireLock: true,
    });
    const malzoniDeps = {
      isProcessAlive: () => false,
      readCmdline: () => null,
      killProcessControlled: (pid) => killed.push(pid),
    };
    const out = reconcileOneSanitaJob(job, now, malzoniDeps);
    assert.equal(out.action, "reconciled");
    const after = readSanitaJob(MALZONI_JOB_ID);
    assert.equal(after.status, "failed");
    assert.equal(after.pid, null);
    assert.equal(findActiveJobByTarget(after.targetKey), null);
    assert.match(after.progress.currentMessage, /Verifica non completata/);
  });
} finally {
  process.chdir(prevCwd);
}

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll sanita-job-reconcile tests PASS");
