import { DatabaseSync } from "node:sqlite";

const file = process.argv[2];
if (!file) throw new Error("frontier sqlite path required");

const db = new DatabaseSync(file, { readOnly: true });
const runColumns = db.prepare("PRAGMA table_info(CrawlRun)").all().map((row) => row.name);
const runs = db.prepare("SELECT * FROM CrawlRun ORDER BY startedAt DESC LIMIT 3").all();
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  .all()
  .map((row) => row.name);
const nodeTable = tables.find((name) => /node/i.test(name));
const nodes = nodeTable
  ? db
      .prepare(
        `SELECT state, COUNT(*) AS count
           FROM "${nodeTable.replaceAll('"', '""')}"
          GROUP BY state
          ORDER BY state`
      )
      .all()
  : [];
console.log(
  JSON.stringify(
    { tables, runColumns, runs, nodeTable, nodes },
    (_, value) => (typeof value === "bigint" ? Number(value) : value),
    2
  )
);
db.close();
