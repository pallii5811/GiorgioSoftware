import { DatabaseSync } from "node:sqlite";

const file = process.argv[2];
const leadId = process.argv[3];
if (!file || !leadId) throw new Error("frontier sqlite path and lead id required");

const db = new DatabaseSync(file, { readOnly: true });
const run = db
  .prepare("SELECT id FROM CrawlRun WHERE leadId = ? ORDER BY startedAt DESC LIMIT 1")
  .get(leadId);
if (!run) {
  console.log("[]");
  db.close();
  process.exit(0);
}
const rawRows = db
  .prepare(
    `SELECT n.canonicalUrl, n.resourceType, n.state, e.ocrStatus,
            e.policyCandidate, e.policyFound, e.normalizedText
       FROM CrawlNodeEvidence e
       JOIN CrawlFrontierNode n ON n.id = e.nodeId
      WHERE e.crawlRunId = ?
        AND n.resourceType IN ('html', 'pdf', 'image', 'document', 'text')
      ORDER BY e.policyFound DESC, e.policyCandidate DESC, n.canonicalUrl`
  )
  .all(run.id);

const terms = /\b(?:polizz\w*|assicur\w*|rct|rco|rc\s+professionale|responsabilit[aà]\s+civile|legge\s+gelli)\b/giu;
const rows = rawRows.flatMap((row) => {
  const source = String(row.normalizedText || "").replace(/\s+/g, " ").trim();
  const matches = [...source.matchAll(terms)];
  if (!row.policyCandidate && !row.policyFound && matches.length === 0) return [];
  const snippets = matches.slice(0, 8).map((match) => {
    const start = Math.max(0, (match.index || 0) - 180);
    const end = Math.min(source.length, (match.index || 0) + match[0].length + 260);
    return source.slice(start, end);
  });
  return [{
    canonicalUrl: row.canonicalUrl,
    resourceType: row.resourceType,
    state: row.state,
    ocrStatus: row.ocrStatus,
    policyCandidate: row.policyCandidate,
    policyFound: row.policyFound,
    snippets,
  }];
});
console.log(JSON.stringify(rows, null, 2));
db.close();
