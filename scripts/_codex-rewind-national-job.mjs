import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";

const jobPath = resolve(process.argv[2] || "");
if (!process.argv[2]) {
  throw new Error("usage: _codex-rewind-national-job.mjs <job.json>");
}

const job = JSON.parse(readFileSync(jobPath, "utf8"));
const completed = Math.max(0, Number(job.progress?.municipalitiesCompleted || 0));
const tmpPath = `${jobPath}.codex-tmp`;
const next = {
  ...job,
  status: "queued",
  pid: null,
  updatedAt: new Date().toISOString(),
  lastHeartbeatAt: new Date().toISOString(),
  progress: {
    ...job.progress,
    municipalitiesCompleted: Math.max(0, completed - 1),
    currentMunicipality: null,
    message: "Ripresa sicura dal comune interrotto dopo aggiornamento motore.",
    frontierLeadId: null,
    frontierState: "STARTING",
    frontierCheckpoint: "Ripresa frontiera persistita",
    frontierCompleted: 0,
    frontierTotal: 0,
    frontierPending: 0,
    frontierFailed: 0,
    frontierLastProgressAt: new Date().toISOString(),
    frontierStalled: false,
  },
};

writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
renameSync(tmpPath, jobPath);
console.log(
  JSON.stringify({
    jobId: job.jobId,
    previousMunicipalitiesCompleted: completed,
    municipalitiesCompleted: next.progress.municipalitiesCompleted,
  })
);
