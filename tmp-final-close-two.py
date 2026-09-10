#!/usr/bin/env python3
"""Unpark Malzoni+Medicanova only; exclude 404/410; preserve attempts history; don't touch other terminals."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone, timedelta
from pathlib import Path

OUT = Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun")
MALZONI = "cmqklex5g00b6108ejom1shk0"
MEDICANOVA = "cmqmaf02a001k9g5crmkdun0w"
ONLY = {MALZONI, MEDICANOVA}

cp = json.loads((OUT / "checkpoint.json").read_text())
now = datetime.now(timezone.utc)

# Never wipe terminals for the other 14
term = cp.get("terminal") or {}
assert len(term) >= 14, f"unexpected terminal count {len(term)}"

rq = cp.setdefault("retryQueue", {})
ip = cp.setdefault("inProgress", {})
attempts = cp.setdefault("attempts", {})

# Clear inProgress only for our two if stale (will be reclaimed by parent)
for lid in list(ip.keys()):
    if lid not in ONLY:
        continue  # leave if somehow other — but shouldn't

# Unpark Malzoni: keep attempts value historically, but clear park ceiling so scheduler can run
# User said preserve attempts history — keep the number but remove year-2027 park
for lid in ONLY:
    meta = rq.get(lid)
    if not meta and lid not in term:
        # ensure retry entry exists from last known
        meta = {
            "attempts": int(attempts.get(lid) or 1),
            "lastReason": "RESUME_FINAL",
            "nextRetryAt": (now - timedelta(seconds=5)).isoformat(),
            "operational": True,
            "firstSeenAt": now.isoformat(),
            "lastAttemptAt": now.isoformat(),
        }
        # find frontier
        cands = sorted((OUT / "frontiers").glob(f"*{lid}*.sqlite"), key=lambda p: p.stat().st_mtime)
        if cands:
            meta["frontierPath"] = str(cands[-1])
            meta["lastRunId"] = cands[-1].stem
        rq[lid] = meta
    if lid in term:
        # already terminal — do not reopen
        rq.pop(lid, None)
        continue
    m = rq[lid]
    # preserve attempts as recorded
    hist = int(attempts.get(lid) or m.get("attempts") or 0)
    m["attempts"] = hist
    attempts[lid] = hist
    m.pop("parkedEngineCeiling", None)
    m["operational"] = True
    m["nextRetryAt"] = (now - timedelta(seconds=5)).isoformat()
    m["lastReason"] = m.get("lastReason") or "RESUME_FINAL"
    # Prefer existing frontier — do not recreate
    if not m.get("frontierPath"):
        cands = sorted((OUT / "frontiers").glob(f"*{lid}*.sqlite"), key=lambda p: p.stat().st_mtime)
        if cands:
            m["frontierPath"] = str(cands[-1])
            m["lastRunId"] = m.get("lastRunId") or cands[-1].stem

# Exclude 404/410 on BOTH frontiers only
excluded = 0
for lid in ONLY:
    if lid in term:
        continue
    m = rq.get(lid) or {}
    fp = m.get("frontierPath")
    if not fp or not Path(fp).exists():
        cands = list((OUT / "frontiers").glob(f"*{lid}*.sqlite"))
        fp = str(sorted(cands, key=lambda p: p.stat().st_mtime)[-1]) if cands else None
    if not fp:
        continue
    con = sqlite3.connect(fp)
    rows = con.execute(
        "SELECT id, retryCount, coalesce(lastError,''), httpStatus, coalesce(discoverySource,''), canonicalUrl "
        "FROM CrawlFrontierNode WHERE state IN ('RETRY_PENDING','QUEUED','DISCOVERED','TECHNICAL_BLOCKED')"
    ).fetchall()
    for nid, rc, err, status, src, url in rows:
        is404 = status in (404, 410) or str(err).upper() in ("HTTP_404", "HTTP_410") or "/trasparenza" in (url or "") and status == 404
        # also check by attempting pattern — only deterministic 404 markers
        if not (status in (404, 410) or str(err).upper() in ("HTTP_404", "HTTP_410")):
            continue
        reason = "SEED_NOT_PRESENT" if src in ("seed", "seed_guess") else "BROKEN_INTERNAL_LINK"
        if "sitemap" in (src or ""):
            reason = "STALE_SITEMAP_URL"
        con.execute(
            "UPDATE CrawlFrontierNode SET state='EXCLUDED', exclusionReason=?, lastError=?, "
            "relevance=CASE WHEN relevance IN ('critical','relevant') THEN relevance ELSE relevance END, "
            "updatedAt=? WHERE id=?",
            (reason, reason, now.isoformat(), nid),
        )
        excluded += 1
    # Medicanova: force /download to low+EXCLUDED if still blocking
    if lid == MEDICANOVA:
        con.execute(
            "UPDATE CrawlFrontierNode SET relevance='low', state='EXCLUDED', "
            "exclusionReason='LOW_RELEVANCE_BREADTH_CAP', lastError='download_403_low', updatedAt=? "
            "WHERE lower(canonicalUrl) LIKE '%/download%' AND state != 'COMPLETED'",
            (now.isoformat(),),
        )
    con.commit()
    con.close()

cp["updatedAt"] = now.isoformat()
(OUT / "checkpoint.json").write_text(json.dumps(cp, indent=2))
print(json.dumps({
    "terminals": len(term),
    "retry": {k: {"attempts": v.get("attempts"), "next": v.get("nextRetryAt"), "fp": v.get("frontierPath")} for k, v in rq.items()},
    "excluded404": excluded,
    "ip": list(ip.keys()),
}, indent=2))
