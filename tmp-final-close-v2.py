#!/usr/bin/env python3
"""Final close: demote Medicanova false HOT (no dual), unpark Malzoni with forceDue, exclude 404s."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone, timedelta
from pathlib import Path

OUT = Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun")
MALZONI = "cmqklex5g00b6108ejom1shk0"
MEDICANOVA = "cmqmaf02a001k9g5crmkdun0w"
now = datetime.now(timezone.utc)
cp = json.loads((OUT / "checkpoint.json").read_text())
term = cp.setdefault("terminal", {})
rq = cp.setdefault("retryQueue", {})
attempts = cp.setdefault("attempts", {})

# Medicanova: dual pass was off — HOT without dual → REVIEW_HUMAN (fail-closed)
if MEDICANOVA in term and term[MEDICANOVA].get("processingState") == "HOT_VERIFIED":
    rp = OUT / "results" / f"{MEDICANOVA}.json"
    row = json.loads(rp.read_text()) if rp.exists() else {}
    dual_ok = bool(row.get("dualPassConfirmed") or row.get("pass2"))
    if not dual_ok:
        term[MEDICANOVA] = {
            "finishedAt": now.isoformat(),
            "processingState": "REVIEW_HUMAN",
            "newVerdict": "REVIEW",
            "reasonCode": "DUAL_PASS_REQUIRED_FOR_HOT",
        }
        if rp.exists():
            row["processingState"] = "REVIEW_HUMAN"
            row["businessVerdict"] = "REVIEW_HUMAN"
            row["reasonCode"] = "DUAL_PASS_REQUIRED_FOR_HOT"
            row["newVerdict"] = "REVIEW"
            rp.write_text(json.dumps(row, indent=2, ensure_ascii=False))
        print("demoted_medicanova_to_REVIEW_HUMAN")

# Malzoni: unpark with forceDue, preserve attempts
assert MALZONI not in term or term.get(MALZONI) is None
# if somehow terminal, don't reopen — but we need him closed properly
if MALZONI in term:
    print("malzoni_already_terminal", term[MALZONI])
else:
    cands = sorted((OUT / "frontiers").glob(f"*{MALZONI}*.sqlite"), key=lambda p: p.stat().st_mtime)
    fp = str(cands[-1]) if cands else None
    hist = int(attempts.get(MALZONI) or (rq.get(MALZONI) or {}).get("attempts") or 5)
    attempts[MALZONI] = hist
    prev = rq.get(MALZONI) or {}
    rq[MALZONI] = {
        **prev,
        "attempts": hist,
        "lastReason": prev.get("lastReason") or "RESUME_FINAL",
        "nextRetryAt": (now - timedelta(seconds=5)).isoformat(),
        "operational": True,
        "forceDue": True,
        "frontierPath": prev.get("frontierPath") or fp,
        "lastRunId": prev.get("lastRunId") or (Path(fp).stem if fp else None),
        "strategy": "resume_boost",
        "firstSeenAt": prev.get("firstSeenAt") or now.isoformat(),
        "lastAttemptAt": now.isoformat(),
    }
    rq[MALZONI].pop("parkedEngineCeiling", None)

    # Exclude all 404/410 deterministically on Malzoni frontier
    if fp and Path(fp).exists():
        con = sqlite3.connect(fp)
        n = 0
        rows = con.execute(
            "SELECT id, coalesce(lastError,''), httpStatus, coalesce(discoverySource,''), canonicalUrl, state "
            "FROM CrawlFrontierNode"
        ).fetchall()
        for nid, err, status, src, url, st in rows:
            is404 = status in (404, 410) or str(err).upper() in ("HTTP_404", "HTTP_410")
            if not is404:
                continue
            if st == "EXCLUDED":
                continue
            reason = "SEED_NOT_PRESENT" if src in ("seed", "seed_guess") else "BROKEN_INTERNAL_LINK"
            if "sitemap" in (src or ""):
                reason = "STALE_SITEMAP_URL"
            con.execute(
                "UPDATE CrawlFrontierNode SET state='EXCLUDED', exclusionReason=?, lastError=?, updatedAt=? WHERE id=?",
                (reason, f"HTTP_{status or 404}:{reason}", now.isoformat(), nid),
            )
            n += 1
        # demote remaining low service flood
        con.execute(
            "UPDATE CrawlFrontierNode SET relevance='low' WHERE relevance IN ('critical','relevant') "
            "AND lower(canonicalUrl) LIKE '%/download%'"
        )
        con.commit()
        # summary
        unresolved = con.execute(
            "SELECT count(*) FROM CrawlFrontierNode WHERE relevance IN ('critical','relevant') "
            "AND state IN ('DISCOVERED','QUEUED','FETCHING','FETCHED','RENDERED','PARSED','RETRY_PENDING')"
        ).fetchone()[0]
        con.close()
        print(json.dumps({"malzoni_excluded404": n, "unresolved_cr": unresolved, "attempts": hist, "fp": fp}))

cp["updatedAt"] = now.isoformat()
# Ensure Medicanova not in retry
rq.pop(MEDICANOVA, None)
(OUT / "checkpoint.json").write_text(json.dumps(cp, indent=2))
print(json.dumps({
    "term": len(cp.get("terminal") or {}),
    "retry": list((cp.get("retryQueue") or {}).keys()),
    "medicanova_term": (cp.get("terminal") or {}).get(MEDICANOVA),
}, indent=2))
