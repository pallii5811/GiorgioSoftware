import { DatabaseSync } from "node:sqlite";

const file = process.argv[2];
const leadId = process.argv[3];
if (!file || !leadId) throw new Error("frontier sqlite path and lead id required");

const db = new DatabaseSync(file, { readOnly: true });
const runs = db
  .prepare("SELECT * FROM CrawlRun WHERE leadId = ? ORDER BY startedAt DESC")
  .all(leadId);
const details = runs.map((run) => ({
  run,
  nodes: db
    .prepare(
      `SELECT state, relevance, resourceType, COUNT(*) AS count
         FROM CrawlFrontierNode
        WHERE crawlRunId = ?
        GROUP BY state, relevance, resourceType
        ORDER BY state, relevance, resourceType`
    )
    .all(run.id),
}));
console.log(
  JSON.stringify(details, (_, value) => (typeof value === "bigint" ? Number(value) : value), 2)
);
db.close();
