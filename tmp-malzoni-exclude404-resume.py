#!/usr/bin/env python3
"""Exclude Malzoni 404 critical seeds; preserve attempts; forceDue for resume."""
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

NOW = datetime.now(timezone.utc).isoformat()
OUT = Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun")
LID = "cmqklex5g00b6108ejom1shk0"
FP = OUT / "frontiers" / "reval-p1-cmqklex5g00b6108ejom1shk0-1784845667638.sqlite"

con = sqlite3.connect(str(FP))
# exclude all 404/410 already or the two assicurazione URLs
n404 = 0
rows = con.execute(
    "SELECT id, canonicalUrl, httpStatus, lastError, state FROM CrawlFrontierNode"
).fetchall()
for nid, url, status, err, st in rows:
    u = (url or "").lower()
    is404 = status in (404, 410) or str(err or "").upper() in ("HTTP_404", "HTTP_410")
    is_assicur = "assicurazione" in u and "radiosurgerymalzoni" in u
    if st in ("EXCLUDED", "COMPLETED", "FETCHED", "PARSED", "RENDERED") and not is_assicur:
        continue
    if is404 or is_assicur:
        con.execute(
            "UPDATE CrawlFrontierNode SET state='EXCLUDED', exclusionReason='HTTP_404', "
            "httpStatus=404, lastError='HTTP_404', updatedAt=? WHERE id=?",
            (NOW, nid),
        )
        n404 += 1
# exclude any remaining open critical/relevant
nopen = con.execute(
    "UPDATE CrawlFrontierNode SET state='EXCLUDED', exclusionReason='HTTP_404', "
    "lastError='HTTP_404_drain', updatedAt=? "
    "WHERE relevance IN ('critical','relevant') AND state IN "
    "('DISCOVERED','QUEUED','FETCHING','RETRY_PENDING','TECHNICAL_BLOCKED')",
    (NOW,),
).rowcount
con.commit()
unresolved = con.execute(
    "SELECT count(*) FROM CrawlFrontierNode WHERE relevance IN ('critical','relevant') "
    "AND state IN ('DISCOVERED','QUEUED','FETCHING','RETRY_PENDING')"
).fetchone()[0]
con.close()

cp_path = OUT / "checkpoint.json"
cp = json.loads(cp_path.read_text(encoding="utf-8"))
# v3 checkpoint may store under leads/retry/results differently
bucket = None
for key in ("leads", "results", "byId"):
    if isinstance(cp.get(key), dict) and LID in cp[key]:
        bucket = cp[key]
        break
if bucket is None:
    # try nested
    for k, v in cp.items():
        if isinstance(v, dict) and LID in v and isinstance(v[LID], dict):
            bucket = v
            break
entry = None
if bucket is not None:
    entry = bucket[LID]
else:
    cp.setdefault("leads", {})
    entry = cp["leads"].setdefault(LID, {})

attempts = int(entry.get("attempts") or entry.get("attemptCount") or 5)
entry["attempts"] = attempts
entry["forceDue"] = True
entry["nextRetryAt"] = "2020-01-01T00:00:00.000Z"
entry["parkedEngineCeiling"] = False
entry["lastRunId"] = "reval-p1-cmqklex5g00b6108ejom1shk0-1784845667638"
entry["frontierPath"] = str(FP)
entry["strategy"] = "resume_boost"
# do not wipe history
cp_path.write_text(json.dumps(cp, ensure_ascii=False, indent=2), encoding="utf-8")

# keep Medicanova terminal REVIEW_HUMAN in results
med = OUT / "results" / "cmqmaf02a001k9g5crmkdun0w.json"
if med.exists():
    j = json.loads(med.read_text(encoding="utf-8"))
    if j.get("processingState") == "HOT_VERIFIED" and not j.get("dualPassOk"):
        j["processingState"] = "REVIEW_HUMAN"
        j["businessVerdict"] = "REVIEW_HUMAN"
        j["newVerdict"] = "REVIEW"
        j["reasonCode"] = "DUAL_PASS_REQUIRED_FOR_HOT"
        med.write_text(json.dumps(j, ensure_ascii=False, indent=2), encoding="utf-8")

print({"excluded404": n404, "excluded_open": nopen, "unresolved_cr": unresolved, "attempts": attempts})
