#!/usr/bin/env python3
import json
import sqlite3
import sys


database_path = sys.argv[1]
url_fragment = sys.argv[2]
connection = sqlite3.connect(database_path)
connection.row_factory = sqlite3.Row
rows = connection.execute(
    """
    SELECT id, state, retryCount, lastError, canonicalUrl,
           parentUrl, discoverySource, completedAt, contentHash, httpStatus
    FROM CrawlFrontierNode
    WHERE canonicalUrl LIKE ?
    """,
    (f"%{url_fragment}%",),
).fetchall()
print(json.dumps([dict(row) for row in rows], ensure_ascii=False, indent=2))
