#!/usr/bin/env python3
import json
import sqlite3
import sys


database_path, lead_id = sys.argv[1:3]
connection = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True)
connection.row_factory = sqlite3.Row
rows = connection.execute(
    """
    SELECT node.crawlRunId, node.canonicalUrl, node.parentUrl,
           node.resourceType, node.relevance, node.state,
           evidence.ocrStatus, evidence.policyCandidate,
           evidence.policyFound, evidence.playwrightSource,
           evidence.extractedAt
      FROM CrawlFrontierNode node
      JOIN CrawlRun run ON run.id = node.crawlRunId
      JOIN CrawlNodeEvidence evidence
        ON evidence.nodeId = node.id
       AND evidence.contentHash = node.contentHash
     WHERE run.leadId = ?
       AND evidence.ocrStatus IS NOT NULL
     ORDER BY node.canonicalUrl
    """,
    (lead_id,),
).fetchall()
print(json.dumps([dict(row) for row in rows], ensure_ascii=False, indent=2))
connection.close()
