#!/usr/bin/env python3
import json
import sqlite3
import sys
from urllib.parse import urlsplit


with open(
    "/opt/leadsniper-revalidate/data/revalidation/checkpoint.json", encoding="utf-8"
) as checkpoint_handle:
    checkpoint = json.load(checkpoint_handle)

requested_lead_ids = set(sys.argv[1:])
targets = [
    (lead_id, metadata.get("frontierPath"))
    for lead_id, metadata in checkpoint.get("inProgress", {}).items()
    if not requested_lead_ids or lead_id in requested_lead_ids
]

for lead_id, path in targets:
    if not path:
        continue
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    try:
        print(json.dumps({"leadId": lead_id, "frontierPath": path}))
        columns = {
            row[1] for row in connection.execute("PRAGMA table_info(CrawlFrontierNode)")
        }
        print(json.dumps({"frontierColumns": sorted(columns)}))
        attempts_column = next(
            (
                column
                for column in ("attemptCount", "attempts", "retryCount")
                if column in columns
            ),
            None,
        )
        attempts_select = attempts_column or "NULL"
        next_retry_column = (
            "nextRetryAt"
            if "nextRetryAt" in columns
            else ("nextAttemptAt" if "nextAttemptAt" in columns else "NULL")
        )
        active_rows = connection.execute(
            f"""
            SELECT state, canonicalUrl AS url, resourceType, {attempts_select} AS attempts,
                   lastError, {next_retry_column} AS nextAttemptAt
            FROM CrawlFrontierNode
            WHERE state IN ('RETRY_PENDING', 'FAILED', 'FETCHING', 'FETCHED', 'RENDERED')
            ORDER BY state, canonicalUrl
            LIMIT 80
            """
        ).fetchall()
        for active_row in active_rows:
            print(json.dumps(dict(active_row), ensure_ascii=False))

        duplicate_count = connection.execute(
            """
            SELECT COUNT(*)
            FROM (
              SELECT canonicalUrl
              FROM CrawlFrontierNode
              GROUP BY canonicalUrl
              HAVING COUNT(*) > 1
            )
            """
        ).fetchone()[0]
        host_counts: dict[str, int] = {}
        for url_row in connection.execute("SELECT canonicalUrl FROM CrawlFrontierNode"):
            host = urlsplit(url_row[0]).netloc.lower()
            host_counts[host] = host_counts.get(host, 0) + 1
        print(
            json.dumps(
                {
                    "duplicateNormalizedUrls": duplicate_count,
                    "hosts": sorted(
                        host_counts.items(), key=lambda item: item[1], reverse=True
                    )[:20],
                }
            )
        )
    finally:
        connection.close()
