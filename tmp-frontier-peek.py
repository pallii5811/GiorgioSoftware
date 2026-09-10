#!/usr/bin/env python3
import sqlite3, json, sys
from collections import Counter
from pathlib import Path

fps = list(Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun/frontiers").glob("*.sqlite"))
want = sys.argv[1:] if len(sys.argv) > 1 else []
for fp in sorted(fps, key=lambda p: p.stat().st_mtime, reverse=True):
    if want and not any(w in fp.name for w in want):
        continue
    con = sqlite3.connect(str(fp))
    try:
        by = Counter(dict(con.execute("SELECT state||'|'||COALESCE(relevance,'?'), count(*) FROM CrawlFrontierNode GROUP BY 1").fetchall()))
        unresolved = con.execute(
            "SELECT relevance, state, count(*) FROM CrawlFrontierNode "
            "WHERE state IN ('DISCOVERED','QUEUED','FETCHING','FETCHED','RENDERED','PARSED','RETRY_PENDING') "
            "GROUP BY 1,2"
        ).fetchall()
        sample = con.execute(
            "SELECT relevance, state, substr(canonicalUrl,1,120) FROM CrawlFrontierNode "
            "WHERE state IN ('DISCOVERED','QUEUED','RETRY_PENDING') ORDER BY CASE relevance WHEN 'critical' THEN 0 WHEN 'relevant' THEN 1 ELSE 2 END LIMIT 15"
        ).fetchall()
        print("===", fp.name)
        print("unresolved", unresolved)
        print("sample", sample[:10])
    finally:
        con.close()
