import fs from "node:fs";

const checkpointPath =
  process.env.REVALIDATE_CHECKPOINT ||
  "/opt/leadsniper-revalidate/data/revalidation/checkpoint.json";
const leadId = process.argv[2] || process.env.TARGET_LEAD_ID;
if (!leadId) throw new Error("lead id required");

const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
console.log(
  JSON.stringify({
    leadId,
    retry: checkpoint.retryQueue?.[leadId] ?? null,
    terminal: checkpoint.terminal?.[leadId] ?? null,
    inProgress: checkpoint.inProgress?.[leadId] ?? null,
  })
);
