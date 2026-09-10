#!/usr/bin/env python3
import json, sqlite3, sys
from datetime import datetime, timezone
fp = sys.argv[1]
con = sqlite3.connect(fp)
now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
pending = con.execute(
    """
    SELECT COUNT(*) FROM CrawlFrontierNode
    WHERE state IN ('DISCOVERED','QUEUED','FETCHING','FETCHED','RENDERED','PARSED')
       OR (state='RETRY_PENDING' AND nextRetryAt IS NOT NULL AND nextRetryAt <= ?)
    """,
    (now,),
).fetchone()[0]
future_pending = con.execute(
    """
    SELECT COUNT(*) FROM CrawlFrontierNode
    WHERE state='RETRY_PENDING' AND (nextRetryAt IS NULL OR nextRetryAt > ?)
    """,
    (now,),
).fetchone()[0]
blocked = con.execute(
    "SELECT COUNT(*) FROM CrawlFrontierNode WHERE state='TECHNICAL_BLOCKED'"
).fetchone()[0]
pdf_pending = con.execute(
    """
    SELECT COUNT(*) FROM CrawlFrontierNode
    WHERE (resourceType IN ('pdf','document','office','image')
           OR lower(canonicalUrl) LIKE '%.pdf%')
      AND state NOT IN ('COMPLETED','EXCLUDED')
    """
).fetchone()[0]
completed = con.execute(
    "SELECT COUNT(*) FROM CrawlFrontierNode WHERE state='COMPLETED'"
).fetchone()[0]
excluded = con.execute(
    "SELECT COUNT(*) FROM CrawlFrontierNode WHERE state='EXCLUDED'"
).fetchone()[0]
total_nodes = con.execute("SELECT COUNT(*) FROM CrawlFrontierNode").fetchone()[0]
row = con.execute("SELECT urlCapReached, timeCapReached, state FROM CrawlRun LIMIT 1").fetchone() or (
    0,
    0,
    None,
)
print(json.dumps({
    "pending": pending,
    "futurePending": future_pending,
    "blocked": blocked,
    "pdfPending": pdf_pending,
    "completed": completed,
    "excluded": excluded,
    "totalNodes": total_nodes,
    "urlCap": int(row[0] or 0),
    "timeCap": int(row[1] or 0),
    "state": row[2],
}))
