#!/usr/bin/env python3
"""Demote TECHNICAL_BLOCKED /download-like relevant nodes to low EXCLUDED so commercial close can proceed."""
import sqlite3
import re
from pathlib import Path
from datetime import datetime, timezone

LOWISH = re.compile(r"download|scaric|wp-content/uploads|fbclid", re.I)
OUT = Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun/frontiers")
n = 0
for fp in OUT.glob("*.sqlite"):
    con = sqlite3.connect(str(fp))
    rows = con.execute(
        "SELECT id, canonicalUrl, relevance, state FROM CrawlFrontierNode "
        "WHERE relevance IN ('critical','relevant')"
    ).fetchall()
    for nid, url, rel, st in rows:
        if LOWISH.search(url or ""):
            con.execute(
                "UPDATE CrawlFrontierNode SET relevance='low', state=CASE WHEN state IN ('TECHNICAL_BLOCKED','RETRY_PENDING','QUEUED','DISCOVERED') THEN 'EXCLUDED' ELSE state END, "
                "exclusionReason='LOW_RELEVANCE_BREADTH_CAP', lastError='demote_download_low', updatedAt=? WHERE id=?",
                (datetime.now(timezone.utc).isoformat(), nid),
            )
            n += 1
    con.commit()
    con.close()
print({"demoted": n})
