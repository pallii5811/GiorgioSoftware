/**
 * Prepare browser-semantic staging DB: Heidy last-mile + published gold evidence from artifact.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(".");
const SRC = path.join(ROOT, "data/staging/db/giorgio-heidy-lastmile.db");
const DST = path.join(ROOT, "data/staging/db/giorgio-browser-semantic.db");
const GOLD = path.join(ROOT, "docs/staging-acceptance/analyzelead-acceptance.json");

if (!fs.existsSync(SRC)) {
  console.error("missing heidy-lastmile db — run staging:heidy-only first");
  process.exit(1);
}
fs.copyFileSync(SRC, DST);

const gold = JSON.parse(fs.readFileSync(GOLD, "utf8"));
const db = new DatabaseSync(DST);
const upd = db.prepare(`
  UPDATE Lead SET
    evidence = ?,
    policyCompany = ?,
    policyNumber = ?,
    policyExpiry = ?,
    policyFound = ?,
    lastScannedAt = ?
  WHERE id = ?
`);

for (const row of gold.results || []) {
  upd.run(
    row.evidenceSnippet || "",
    row.policyCompany ?? null,
    row.policyNumber ?? null,
    row.policyExpiry ? Date.parse(row.policyExpiry) : null,
    row.token === "PUBLISHED" ? 1 : 0,
    Date.now(),
    row.id
  );
}
db.close();
console.log(JSON.stringify({ prepared: DST, publishedRows: (gold.results || []).length }, null, 2));
