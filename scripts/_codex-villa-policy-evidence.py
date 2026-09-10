#!/usr/bin/env python3
import json
import re
import sqlite3
import sys

database_path = sys.argv[1]
lead_id = sys.argv[2]
connection = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True)
connection.row_factory = sqlite3.Row
rows = connection.execute(
    """
    SELECT node.id AS nodeId, node.crawlRunId, node.canonicalUrl, node.state,
           evidence.policyFound, evidence.policySignalsJson,
           evidence.policyText, evidence.normalizedText
      FROM CrawlFrontierNode node
      JOIN CrawlRun run ON run.id = node.crawlRunId
      LEFT JOIN CrawlNodeEvidence evidence ON evidence.nodeId = node.id
     WHERE run.leadId = ?
       AND lower(node.canonicalUrl) LIKE '%polizza-rct-rco%'
     ORDER BY node.canonicalUrl, evidence.extractedAt DESC
    """,
    (lead_id,),
).fetchall()

result = []
for row in rows:
    item = dict(row)
    text = item.pop("policyText") or item.pop("normalizedText") or ""
    item.pop("normalizedText", None)
    item["text"] = re.sub(r"\s+", " ", text)[:8000]
    result.append(item)

print(json.dumps(result, ensure_ascii=False, indent=2))
connection.close()
