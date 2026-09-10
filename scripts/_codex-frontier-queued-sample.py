#!/usr/bin/env python3
import json
import sqlite3
import sys


if len(sys.argv) != 2:
    raise SystemExit("usage: _codex-frontier-queued-sample.py FRONTIER.sqlite")

connection = sqlite3.connect(sys.argv[1])
connection.row_factory = sqlite3.Row
try:
    for row in connection.execute(
        """
        SELECT canonicalUrl, resourceType, discoverySource, parentUrl
        FROM CrawlFrontierNode
        WHERE state IN ('DISCOVERED', 'QUEUED')
        ORDER BY discoveredAt DESC
        LIMIT 120
        """
    ):
        print(json.dumps(dict(row), ensure_ascii=False))
finally:
    connection.close()
