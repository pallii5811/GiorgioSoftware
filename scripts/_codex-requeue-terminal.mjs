import fs from "node:fs";
import path from "node:path";

const checkpointPath =
  process.env.REVALIDATE_CHECKPOINT ||
  "/opt/leadsniper-revalidate/data/revalidation/checkpoint.json";
const resultsDir =
  process.env.REVALIDATE_RESULTS_DIR ||
  "/opt/leadsniper-revalidate/data/revalidation/results";
const leadId = process.env.TARGET_LEAD_ID || process.argv[2];
if (!leadId) throw new Error("lead id required");

const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
const terminal = checkpoint.terminal?.[leadId];
if (!terminal) throw new Error(`Target is not terminal: ${leadId}`);
const result = JSON.parse(
  fs.readFileSync(path.join(resultsDir, `${leadId}.json`), "utf8")
);
const frontierPath = result.frontierPaths?.at(-1) ?? null;
const lastRunId = result.runIds?.at(-1) ?? null;
if (!frontierPath || !lastRunId) {
  throw new Error(`Terminal result lacks resumable frontier proof: ${leadId}`);
}

const backupPath = `${checkpointPath}.before-terminal-requeue-${leadId}-${Date.now()}.bak`;
fs.copyFileSync(checkpointPath, backupPath, fs.constants.COPYFILE_EXCL);
delete checkpoint.terminal[leadId];
const now = new Date().toISOString();
checkpoint.retryQueue ||= {};
checkpoint.retryQueue[leadId] = {
  attempts: 0,
  lastReason: process.env.TARGET_REASON || "DETECTOR_RECERTIFICATION",
  lastError: process.env.TARGET_REASON || "DETECTOR_RECERTIFICATION",
  nextRetryAt: "0001-01-01T00:00:00.000Z",
  lastRunId,
  frontierPath,
  passLabel: result.passLabel || "p1",
  strategy: "resume_boost",
  firstSeenAt: now,
  lastAttemptAt: now,
  operational: true,
};

const tmpPath = path.join(
  path.dirname(checkpointPath),
  `.${path.basename(checkpointPath)}.${process.pid}.tmp`
);
fs.writeFileSync(tmpPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
fs.renameSync(tmpPath, checkpointPath);
console.log(
  JSON.stringify({ leadId, backupPath, frontierPath, lastRunId })
);
