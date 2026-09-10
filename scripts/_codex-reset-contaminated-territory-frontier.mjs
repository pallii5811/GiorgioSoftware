#!/usr/bin/env node

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const file = process.argv[2];
const leadId = process.argv[3];
const backup = process.argv[4];
if (!file || !leadId || !backup) {
  throw new Error("frontier sqlite path, lead id and backup path required");
}

const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
const quoteSqlString = (value) => `'${String(value).replaceAll("'", "''")}'`;

const db = new DatabaseSync(file);
try {
  const runs = db
    .prepare("SELECT id FROM CrawlRun WHERE leadId = ? ORDER BY startedAt")
    .all(leadId)
    .map((row) => String(row.id));
  if (runs.length === 0) {
    console.log(JSON.stringify({ leadId, resetRuns: 0, backup: null }));
    process.exit(0);
  }

  mkdirSync(dirname(backup), { recursive: true });
  db.exec(`VACUUM INTO ${quoteSqlString(backup)}`);

  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    )
    .all()
    .map((row) => String(row.name));

  const deleted = {};
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const table of tables) {
      if (table === "CrawlRun") continue;
      const columns = db
        .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
        .all()
        .map((row) => String(row.name));
      if (!columns.includes("crawlRunId")) continue;
      let count = 0;
      const statement = db.prepare(
        `DELETE FROM ${quoteIdentifier(table)} WHERE crawlRunId = ?`
      );
      for (const runId of runs) count += Number(statement.run(runId).changes || 0);
      deleted[table] = count;
    }

    let resetRuns = 0;
    const deleteRun = db.prepare("DELETE FROM CrawlRun WHERE id = ?");
    for (const runId of runs) resetRuns += Number(deleteRun.run(runId).changes || 0);
    db.exec("COMMIT");
    console.log(JSON.stringify({ leadId, resetRuns, deleted, backup }, null, 2));
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
} finally {
  db.close();
}
