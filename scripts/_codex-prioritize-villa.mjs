import fs from "node:fs";
import path from "node:path";

const checkpointPath =
  process.env.REVALIDATE_CHECKPOINT ||
  "/opt/leadsniper-revalidate/data/revalidation/checkpoint.json";
const leadId =
  process.env.TARGET_LEAD_ID || "cmqkld5s700a8108eti0nofjv";

const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
const retry = checkpoint.retryQueue?.[leadId];
if (!retry) {
  throw new Error(`Target lead is not present in retryQueue: ${leadId}`);
}

const backupPath = `${checkpointPath}.before-villa-v4-${Date.now()}.bak`;
fs.copyFileSync(checkpointPath, backupPath, fs.constants.COPYFILE_EXCL);

retry.nextRetryAt = "0001-01-01T00:00:00.000Z";
retry.forceDue = true;
retry.operational = true;
retry.lastReason =
  process.env.TARGET_REASON || "EXHAUSTIVE_SITE_RECERTIFICATION";

const tmpPath = path.join(
  path.dirname(checkpointPath),
  `.${path.basename(checkpointPath)}.${process.pid}.tmp`
);
fs.writeFileSync(tmpPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
fs.renameSync(tmpPath, checkpointPath);

console.log(
  JSON.stringify({
    leadId,
    backupPath,
    nextRetryAt: retry.nextRetryAt,
    frontierPath: retry.frontierPath,
  })
);
