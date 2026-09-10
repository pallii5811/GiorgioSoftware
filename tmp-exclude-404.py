#!/usr/bin/env python3
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

OUT = Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun/frontiers")
n = 0
for fp in OUT.glob("*.sqlite"):
    con = sqlite3.connect(str(fp))
    rows = con.execute(
        "SELECT id, retryCount, coalesce(lastError,''), httpStatus, coalesce(discoverySource,'') "
        "FROM CrawlFrontierNode WHERE state='RETRY_PENDING'"
    ).fetchall()
    for nid, rc, err, status, src in rows:
        is404 = status in (404, 410) or err.upper() in ("HTTP_404", "HTTP_410")
        if not is404:
            continue
        if int(rc or 0) < 1 and src == "seed":
            continue
        reason = "SEED_NOT_PRESENT" if src in ("seed", "seed_guess") else "BROKEN_INTERNAL_LINK"
        if "sitemap" in src:
            reason = "STALE_SITEMAP_URL"
        con.execute(
            "UPDATE CrawlFrontierNode SET state='EXCLUDED', exclusionReason=?, lastError=?, updatedAt=? WHERE id=?",
            (reason, reason, datetime.now(timezone.utc).isoformat(), nid),
        )
        n += 1
    con.commit()
    con.close()
print({"excluded404": n})
