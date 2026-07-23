#!/usr/bin/env python3
import json, sqlite3, sys
fp = sys.argv[1]
con = sqlite3.connect(fp)
pending = con.execute(
    "SELECT COUNT(*) FROM CrawlFrontierNode WHERE state IN ('DISCOVERED','QUEUED','RETRY_PENDING','FETCHING')"
).fetchone()[0]
row = con.execute("SELECT urlCapReached, timeCapReached, state FROM CrawlRun LIMIT 1").fetchone() or (
    0,
    0,
    None,
)
print(json.dumps({"pending": pending, "urlCap": int(row[0] or 0), "timeCap": int(row[1] or 0), "state": row[2]}))
