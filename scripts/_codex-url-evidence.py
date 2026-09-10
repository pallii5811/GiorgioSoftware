#!/usr/bin/env python3
import json
import sqlite3
import sys

frontier_path = sys.argv[1]
url_fragment = sys.argv[2] if len(sys.argv) > 2 else ""
connection = sqlite3.connect(f"file:{frontier_path}?mode=ro", uri=True)
connection.row_factory = sqlite3.Row
rows = connection.execute(
    """
    SELECT node.id AS nodeId, node.canonicalUrl, node.state,
           node.contentHash AS currentHash, evidence.contentHash AS evidenceHash,
           evidence.policyFound, evidence.policyCandidate,
           evidence.policySignalsJson, evidence.extractedAt,
           length(evidence.normalizedText) AS textLength,
           instr(lower(evidence.normalizedText), 'rch00020000239') AS policyNumberOffset,
           substr(
             evidence.normalizedText,
             max(1, instr(lower(evidence.normalizedText), 'polizza assicurativa') - 200),
             1200
           ) AS policyContext
    FROM CrawlFrontierNode node
    LEFT JOIN CrawlNodeEvidence evidence ON evidence.nodeId = node.id
    WHERE lower(node.canonicalUrl) LIKE lower(?)
    ORDER BY node.canonicalUrl, evidence.extractedAt DESC
    """,
    (f"%{url_fragment}%",),
).fetchall()
print(json.dumps([dict(row) for row in rows], ensure_ascii=False, indent=2))
connection.close()
