#!/usr/bin/env python3
"""Quarantine TECHNICAL_BLOCKED (+ optional stuck PDFs) so resume can complete.

Does NOT wipe frontier / completed nodes. Sets run back to RUNNING, clears caps.
Stdout: JSON {quarantined, pdfIsolated, pending, runState}
"""
import json, sqlite3, sys
from datetime import datetime, timezone

fp = sys.argv[1]
isolate_pdfs = "--isolate-pdfs" in sys.argv
now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
con = sqlite3.connect(fp)
con.row_factory = sqlite3.Row

# 1) TECHNICAL_BLOCKED → EXCLUDED (isolate single failed relevant URL)
cur = con.execute(
    """
    UPDATE CrawlFrontierNode
    SET state='EXCLUDED',
        exclusionReason=COALESCE(exclusionReason,'') || CASE WHEN exclusionReason IS NULL OR exclusionReason='' THEN '' ELSE ';' END || 'RETRY_ISOLATE_TECHNICAL_BLOCKED',
        updatedAt=?,
        completedAt=COALESCE(completedAt, ?)
    WHERE state='TECHNICAL_BLOCKED'
    """,
    (now, now),
)
quarantined = cur.rowcount

pdf_isolated = 0
if isolate_pdfs:
    # Isolate PDFs that already failed retries or sit FETCHED forever without completing.
    cur = con.execute(
        """
        UPDATE CrawlFrontierNode
        SET state='EXCLUDED',
            exclusionReason=COALESCE(exclusionReason,'') || CASE WHEN exclusionReason IS NULL OR exclusionReason='' THEN '' ELSE ';' END || 'RETRY_ISOLATE_PDF',
            updatedAt=?,
            completedAt=COALESCE(completedAt, ?)
        WHERE state IN ('TECHNICAL_BLOCKED','RETRY_PENDING')
          AND (lower(canonicalUrl) LIKE '%.pdf%' OR resourceType='pdf')
          AND retryCount >= 2
        """,
        (now, now),
    )
    pdf_isolated = cur.rowcount

# Recompute pending-ish
pending = con.execute(
    """
    SELECT COUNT(*) FROM CrawlFrontierNode
    WHERE state IN ('DISCOVERED','QUEUED','FETCHING','FETCHED','RENDERED','PARSED','RETRY_PENDING')
    """
).fetchone()[0]

# Clear sticky caps / FAILED so resume can continue; never delete nodes.
con.execute(
    """
    UPDATE CrawlRun
    SET state='RUNNING',
        urlCapReached=0,
        timeCapReached=0,
        workerLock=NULL,
        stopReason=NULL,
        heartbeatAt=?
    """,
    (now,),
)
# If sitemap is the only external block and HTML queue empty, downgrade FAILED→NOT_PRESENT
# only when robots-referenced sitemap could not be fetched (external). Keeps false-HOT closed
# via remaining gates; coordinator/worker may still emit REVIEW_HUMAN.
row = con.execute("SELECT sitemapStatus FROM CrawlRun LIMIT 1").fetchone()
sitemap = row["sitemapStatus"] if row else None
if pending == 0 and sitemap in ("ROBOTS_REFERENCED_FAILED", "DISCOVERED_FAILED", "FAILED"):
    con.execute("UPDATE CrawlRun SET sitemapStatus='NOT_PRESENT' WHERE sitemapStatus=?", (sitemap,))

con.commit()
run = con.execute("SELECT state, sitemapStatus, totalPending, totalFailed FROM CrawlRun LIMIT 1").fetchone()
print(
    json.dumps(
        {
            "quarantined": int(quarantined or 0),
            "pdfIsolated": int(pdf_isolated or 0),
            "pending": int(pending or 0),
            "runState": run["state"] if run else None,
            "sitemapStatus": run["sitemapStatus"] if run else None,
        }
    )
)
con.close()
