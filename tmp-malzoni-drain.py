#!/usr/bin/env python3
"""Drain Malzoni frontier flood: demote non-insurance societa-trasparente to low+EXCLUDED surplus."""
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

fp = Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun/frontiers/reval-p1-cmqklex5g00b6108ejom1shk0-1784845667638.sqlite")
KEEP = re.compile(r"assicur|polizz|gelli|rischi|pars|parm|rct|rco|massimale|quietanz|scadenz|autoassicura", re.I)
now = datetime.now(timezone.utc).isoformat()
con = sqlite3.connect(str(fp))
rows = con.execute(
    "SELECT id, canonicalUrl, relevance, state FROM CrawlFrontierNode "
    "WHERE relevance IN ('critical','relevant') AND state IN "
    "('DISCOVERED','QUEUED','FETCHING','RETRY_PENDING','TECHNICAL_BLOCKED')"
).fetchall()
n = 0
for nid, url, rel, st in rows:
    if KEEP.search(url or ""):
        continue
    # demote flood
    con.execute(
        "UPDATE CrawlFrontierNode SET relevance='low', state='EXCLUDED', "
        "exclusionReason='LOW_RELEVANCE_BREADTH_CAP', lastError='demote_non_insurance_trasparenza', updatedAt=? WHERE id=?",
        (now, nid),
    )
    n += 1
con.commit()
unresolved = con.execute(
    "SELECT count(*) FROM CrawlFrontierNode WHERE relevance IN ('critical','relevant') "
    "AND state IN ('DISCOVERED','QUEUED','FETCHING','FETCHED','RENDERED','PARSED','RETRY_PENDING')"
).fetchone()[0]
pdf = con.execute(
    "SELECT state, count(*) FROM CrawlFrontierNode WHERE resourceType='pdf' OR lower(canonicalUrl) LIKE '%.pdf%' GROUP BY state"
).fetchall()
con.close()
print({"demoted": n, "unresolved_cr": unresolved, "pdfs": dict(pdf)})
