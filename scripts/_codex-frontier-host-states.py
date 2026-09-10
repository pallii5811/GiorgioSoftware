#!/usr/bin/env python3
import json
import sqlite3
import sys
from urllib.parse import urlsplit


database_path = sys.argv[1]
connection = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True)
connection.row_factory = sqlite3.Row
rows = connection.execute(
    """
    SELECT run.leadId, node.crawlRunId, node.canonicalUrl, node.state,
           node.resourceType, node.lastError
      FROM CrawlFrontierNode node
      JOIN CrawlRun run ON run.id = node.crawlRunId
    """
).fetchall()
summary = {}
for row in rows:
    host = urlsplit(row["canonicalUrl"]).hostname or "INVALID"
    key = (row["leadId"], host, row["state"])
    summary[key] = summary.get(key, 0) + 1
result = [
    {"leadId": lead_id, "host": host, "state": state, "count": count}
    for (lead_id, host, state), count in sorted(
        summary.items(), key=lambda item: (item[0][0], item[0][1], item[0][2])
    )
]
print(json.dumps(result, ensure_ascii=False, indent=2))
connection.close()
