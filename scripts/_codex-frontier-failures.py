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
           node.discoverySource, node.resourceType, node.relevance,
           node.state, node.retryCount, node.lastError,
           node.exclusionReason, node.httpStatus
      FROM CrawlFrontierNode node
      JOIN CrawlRun run ON run.id = node.crawlRunId
     WHERE run.leadId = ?
       AND node.state IN ('TECHNICAL_BLOCKED', 'RETRY_PENDING', 'FETCHING', 'FETCHED')
     ORDER BY node.state, node.relevance, node.canonicalUrl
    """,
    (lead_id,),
).fetchall()
print(json.dumps([dict(row) for row in rows], ensure_ascii=False, indent=2))
connection.close()
