import { DatabaseSync } from "node:sqlite";

const file = process.argv[2];
const leadId = process.argv[3];
if (!file || !leadId) throw new Error("frontier sqlite path and lead id required");
process.env.FRONTIER_DB_PATH = file;
process.env.CRAWL_REQUIRE_EXHAUSTIVE_SITE = "1";
process.env.CRAWL_RENDER_EVERY_HTML = "1";

const db = new DatabaseSync(file, { readOnly: true });
const run = db
  .prepare("SELECT id FROM CrawlRun WHERE leadId = ? ORDER BY startedAt DESC LIMIT 1")
  .get(leadId);
db.close();
if (!run) throw new Error("crawl run not found");

const { deriveCrawlCompleteness, deriveExhaustiveSiteCoverage, getCrawlRun, openFrontierStore } =
  await import("@/lib/sanita/frontier-store");
openFrontierStore(file);
console.log(JSON.stringify({
  run: getCrawlRun(run.id),
  completeness: deriveCrawlCompleteness(run.id),
  coverage: deriveExhaustiveSiteCoverage(run.id),
}, null, 2));
