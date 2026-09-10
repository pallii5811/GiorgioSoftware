#!/usr/bin/env python3
import sqlite3, os, time
from pathlib import Path
fp = Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun/frontiers/reval-p1-cmqmaf02a001k9g5crmkdun0w-1784849158140.sqlite")
con = sqlite3.connect(str(fp))
print("nodes", con.execute("select state, relevance, count(*) from CrawlFrontierNode group by 1,2").fetchall())
print(
    "failed",
    con.execute(
        "select state, substr(canonicalUrl,1,120), coalesce(lastError,'') "
        "from CrawlFrontierNode where state in ('TECHNICAL_BLOCKED','RETRY_PENDING') limit 15"
    ).fetchall(),
)
con.close()
print("utc", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
