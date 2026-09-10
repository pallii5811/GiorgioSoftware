#!/usr/bin/env python3
"""Snapshot revalidation health for user status."""
import json, os, glob, time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

CP = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
RES = Path("/opt/leadsniper-revalidate/data/revalidation/results")

cp = json.loads(CP.read_text(encoding="utf-8"))
term = cp.get("terminal") or {}
rq = cp.get("retryQueue") or {}
inp = cp.get("inProgress") or {}
stats = cp.get("stats") or {}
attempts = cp.get("attempts") or {}

states = Counter(v.get("processingState") for v in term.values())
reasons = Counter()
strategies = Counter()
force_due = 0
due_now = 0
parked = 0
high_attempts = 0
audit = 0
now = datetime.now(timezone.utc)

for lid, v in rq.items():
    r = str(v.get("lastReason") or v.get("lastError") or "?")
    # normalize reason family
    fam = r.split(":")[0].split("_", 2)
    key = r[:60]
    if "HOT_SMALL" in r or "HOT_MID" in r or "AUDIT" in r:
        key = "AUDIT_*"
        audit += 1
    elif "CRAWL_CAP" in r or "CAP" in r:
        key = "CRAWL_CAP"
    elif "ANALYZE" in r:
        key = "ANALYZE_ERROR_OR_TIMEOUT"
    elif "PDF" in r:
        key = "PDF_*"
    elif "IDENTITY" in r:
        key = "IDENTITY_*"
    elif "WALL" in r or "TIMEOUT" in r:
        key = "WALL/TIMEOUT"
    elif "INCOMPLETE" in r or "FRONTIER" in r or "OPEN" in r:
        key = "INCOMPLETE/FRONTIER"
    elif "SIGTERM" in r or "OOM" in r:
        key = "SIGTERM/OOM"
    else:
        key = r.split(":")[0][:40] or "?"
    reasons[key] += 1
    strategies[str(v.get("strategy") or "?")] += 1
    if v.get("forceDue"):
        force_due += 1
    nra = v.get("nextRetryAt")
    try:
        if nra:
            dt = datetime.fromisoformat(str(nra).replace("Z", "+00:00"))
            if dt <= now:
                due_now += 1
            elif dt.year >= 2099 or (dt - now).total_seconds() > 6 * 3600:
                parked += 1
        else:
            due_now += 1
    except Exception:
        due_now += 1
    att = int(v.get("attempts") or attempts.get(lid) or 0)
    if att >= 5:
        high_attempts += 1

# age of checkpoint
mtime = CP.stat().st_mtime
age_s = time.time() - mtime

print(json.dumps({
    "checkpoint_age_sec": int(age_s),
    "updatedAt": cp.get("updatedAt"),
    "stats": stats,
    "terminal_n": len(term),
    "terminal_by_state": dict(states.most_common()),
    "retry_n": len(rq),
    "inProgress_n": len(inp),
    "inProgress_ids": list(inp.keys())[:5],
    "retry_reasons_top": dict(reasons.most_common(15)),
    "retry_strategies": dict(strategies.most_common()),
    "retry_due_now": due_now,
    "retry_forceDue": force_due,
    "retry_parked_or_far": parked,
    "retry_attempts_ge_5": high_attempts,
    "audit_tagged": audit,
    "commercial_done": {
        "hot": states.get("HOT_VERIFIED", 0),
        "pub": sum(1 for s, n in states.items() if str(s).startswith("PUBLISHED")),
        "si": states.get("SELF_INSURANCE_VERIFIED", 0),
        "review": states.get("REVIEW_HUMAN", 0),
        "tech": states.get("TECHNICAL_BLOCKED", 0),
    },
    "progress_approx": f"{len(term)} terminal + {len(rq)} retry + {len(inp)} running (pool ~877)",
}, indent=2, ensure_ascii=False))
