#!/usr/bin/env python3
import sqlite3
fp = "/opt/leadsniper-revalidate/data/stopship-retry11-rerun/frontiers/reval-p1-cmqklex5g00b6108ejom1shk0-1784845667638.sqlite"
con = sqlite3.connect(fp)
print(
    "retry",
    con.execute(
        "select substr(canonicalUrl,1,90), state, retryCount, nextRetryAt, coalesce(lastError,'') "
        "from CrawlFrontierNode where state='RETRY_PENDING' limit 12"
    ).fetchall(),
)
print(
    "crit",
    con.execute(
        "select state, count(*) from CrawlFrontierNode where relevance='critical' group by state"
    ).fetchall(),
)
print(
    "blocked",
    con.execute(
        "select substr(canonicalUrl,1,90), lastError from CrawlFrontierNode where state='TECHNICAL_BLOCKED' limit 10"
    ).fetchall(),
)
con.close()
