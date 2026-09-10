import { DatabaseSync } from "node:sqlite";

const file = process.argv[2];
const leadId = process.argv[3];
const pattern = process.argv[4];
if (!file || !leadId) throw new Error("frontier sqlite path and lead id required");

const db = new DatabaseSync(file, { readOnly: true });
const run = db
  .prepare("SELECT id FROM CrawlRun WHERE leadId = ? ORDER BY startedAt DESC LIMIT 1")
  .get(leadId);
const nodes = run && pattern
  ? db
      .prepare(
        `SELECT canonicalUrl, parentUrl, state, relevance, resourceType, httpStatus, retryCount, lastError
           FROM CrawlFrontierNode
          WHERE crawlRunId = ? AND canonicalUrl LIKE ?
          ORDER BY canonicalUrl
          LIMIT 100`
      )
      .all(run.id, `%${pattern}%`)
  : run
  ? db
      .prepare(
        `SELECT canonicalUrl, parentUrl, state, relevance, resourceType, httpStatus, retryCount, lastError
           FROM CrawlFrontierNode
          WHERE crawlRunId = ?
            AND state IN ('TECHNICAL_BLOCKED', 'RETRY_PENDING')
          ORDER BY relevance DESC, state, canonicalUrl
          LIMIT 100`
      )
      .all(run.id)
  : [];
console.log(JSON.stringify(nodes, null, 2));
db.close();
