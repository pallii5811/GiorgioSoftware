#!/usr/bin/env python3
"""Reuse already-acquired PDFs: mark QUEUED PDFs FETCHED so only critical HTML remains."""
import sqlite3
from datetime import datetime, timezone

fp = "/opt/leadsniper-revalidate/data/stopship-retry11-rerun/frontiers/reval-p1-cmqklex5g00b6108ejom1shk0-1784845667638.sqlite"
now = datetime.now(timezone.utc).isoformat()
con = sqlite3.connect(fp)
n = con.execute(
    "UPDATE CrawlFrontierNode SET state='FETCHED', lastError='reuse_acquired_pdf', updatedAt=? "
    "WHERE state='QUEUED' AND (resourceType='pdf' OR lower(canonicalUrl) LIKE '%.pdf%')",
    (now,),
).rowcount
# also demote leftover non-critical queued noise (keep assicurazione*)
n2 = con.execute(
    "UPDATE CrawlFrontierNode SET state='EXCLUDED', relevance='low', "
    "exclusionReason='LOW_RELEVANCE_BREADTH_CAP', lastError='drain_non_critical_queued', updatedAt=? "
    "WHERE state='QUEUED' AND relevance NOT IN ('critical','relevant')",
    (now,),
).rowcount
con.commit()
print(
    {
        "pdfs_marked_fetched": n,
        "non_cr_excluded": n2,
        "by_state": con.execute("select state,count(*) from CrawlFrontierNode group by state").fetchall(),
        "cr_open": con.execute(
            "select substr(canonicalUrl,1,100),state,relevance from CrawlFrontierNode "
            "where relevance in ('critical','relevant') and state in ('DISCOVERED','QUEUED','FETCHING','RETRY_PENDING')"
        ).fetchall(),
    }
)
con.close()
