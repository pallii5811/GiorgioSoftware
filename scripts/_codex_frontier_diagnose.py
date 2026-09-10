#!/usr/bin/env python3
import collections
import json
import sqlite3
import sys
import urllib.parse


frontier_path = sys.argv[1]
connection = sqlite3.connect(frontier_path)
connection.row_factory = sqlite3.Row

columns = {
    row["name"]
    for row in connection.execute("PRAGMA table_info(CrawlFrontierNode)")
}
wanted = [
    name
    for name in (
        "id",
        "canonicalUrl",
        "state",
        "resourceType",
        "relevance",
        "depth",
        "discoveredFrom",
        "retryCount",
        "lastError",
        "nextRetryAt",
    )
    if name in columns
]
nodes = [
    dict(row)
    for row in connection.execute(
        f'SELECT {", ".join(wanted)} FROM CrawlFrontierNode'
    )
]

states = collections.Counter()
resource_types = collections.Counter()
hosts = collections.Counter()
path_roots = collections.Counter()
query_keys = collections.Counter()
errors = collections.Counter()

for node in nodes:
    states[str(node.get("state"))] += 1
    resource_types[str(node.get("resourceType"))] += 1
    errors[str(node.get("lastError") or "NONE")] += 1
    try:
        parsed = urllib.parse.urlsplit(node.get("canonicalUrl") or "")
        hosts[parsed.netloc.lower()] += 1
        parts = [part for part in parsed.path.split("/") if part]
        path_roots["/" + "/".join(parts[:2])] += 1
        for key in urllib.parse.parse_qs(parsed.query, keep_blank_values=True):
            query_keys[key] += 1
    except ValueError:
        pass

open_states = {
    "DISCOVERED",
    "QUEUED",
    "FETCHING",
    "FETCHED",
    "RENDERED",
    "PARSED",
    "RETRY_PENDING",
    "TECHNICAL_BLOCKED",
}
open_nodes = [node for node in nodes if node.get("state") in open_states]

summary = {
    "frontierPath": frontier_path,
    "columns": sorted(columns),
    "total": len(nodes),
    "states": states.most_common(),
    "resourceTypes": resource_types.most_common(),
    "hosts": hosts.most_common(20),
    "pathRoots": path_roots.most_common(40),
    "queryKeys": query_keys.most_common(30),
    "errors": errors.most_common(30),
    "openExamples": open_nodes[:100],
}
print(json.dumps(summary, ensure_ascii=False, indent=2))
connection.close()
