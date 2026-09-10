import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const directory = process.argv[2];
const leadId = process.argv[3];
if (!directory || !leadId) throw new Error("frontier directory and lead id required");

const matches = [];
for (const name of readdirSync(directory)) {
  if (!name.endsWith(".sqlite")) continue;
  const file = join(directory, name);
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    const row = db
      .prepare("SELECT id, status, startedAt, completedAt FROM CrawlRun WHERE leadId = ? ORDER BY startedAt DESC LIMIT 1")
      .get(leadId);
    db.close();
    if (row) matches.push({ file, ...row });
  } catch {
    // Ignore unrelated or incomplete SQLite files.
  }
}

console.log(JSON.stringify(matches, null, 2));
