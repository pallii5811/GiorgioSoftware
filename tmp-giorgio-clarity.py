#!/usr/bin/env python3
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

cp = json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
rq = cp.get("retryQueue") or {}
reasons = Counter()
attempts = []
for lid, m in rq.items():
    reasons[m.get("lastReason") or "?"] += 1
    attempts.append(int(m.get("attempts") or 0))
    print(
        json.dumps(
            {
                "id": lid,
                "attempts": m.get("attempts"),
                "reason": m.get("lastReason"),
                "next": m.get("nextRetryAt"),
                "park": m.get("parkReason"),
                "strategy": m.get("strategy"),
            }
        )
    )

print("---SUMMARY---")
print(
    json.dumps(
        {
            "terminal": len(cp.get("terminal") or {}),
            "terminal_keys": list((cp.get("terminal") or {}).keys())[:20],
            "retry_n": len(rq),
            "reasons": dict(reasons),
            "attempts_min_max": [min(attempts) if attempts else 0, max(attempts) if attempts else 0],
            "inProgress": cp.get("inProgress"),
            "updatedAt": cp.get("updatedAt"),
        },
        indent=2,
    )
)

# terminal outcomes
terms = cp.get("terminal") or {}
tstates = Counter()
for v in terms.values():
    if isinstance(v, dict):
        tstates[v.get("outcome") or v.get("processingState") or v.get("state") or str(v)[:40]] += 1
    else:
        tstates[str(v)[:40]] += 1
print("TERMINAL_STATES", dict(tstates))
# sample one terminal
if terms:
    k = next(iter(terms))
    print("SAMPLE_TERM", k, json.dumps(terms[k])[:500])

# timing: wallMs from worker_done since start
log = Path("/opt/leadsniper-revalidate/logs/systemd-revalidate.log").read_text(errors="replace").splitlines()
start_i = max(i for i, l in enumerate(log) if "revalidate_v3_start" in l)
walls = []
reasons_done = Counter()
for line in log[start_i:]:
    if '"event":"worker_done"' in line:
        try:
            ev = json.loads(line)
            walls.append(ev.get("wallMs") or 0)
        except Exception:
            pass
    if '"event":"retry_ceiling_keep_operational"' in line or '"lastReason"' in line and "lead_done" in line:
        pass
    if '"event":"lead_done"' in line:
        try:
            ev = json.loads(line)
        except Exception:
            continue

# extract lastReason from nearby retry events
for line in log[start_i:]:
    if "lastReason" in line and ("retry_ceiling" in line or "retry_schedule" in line or "RETRY" in line):
        try:
            ev = json.loads(line)
            if ev.get("lastReason"):
                reasons_done[ev["lastReason"]] += 1
        except Exception:
            pass

print(
    "WALL_MS",
    {
        "n": len(walls),
        "avg_s": round(sum(walls) / len(walls) / 1000, 1) if walls else None,
        "min_s": round(min(walls) / 1000, 1) if walls else None,
        "max_s": round(max(walls) / 1000, 1) if walls else None,
        "sum_min": round(sum(walls) / 1000 / 60, 1) if walls else None,
    },
)
print("REASONS_IN_LOG", dict(reasons_done))

# elapsed since start
start = datetime.fromisoformat("2026-07-23T20:19:55+00:00")
now = datetime.now(timezone.utc)
elapsed_h = (now - start).total_seconds() / 3600
# lead attempts completed (worker_done)
n = len(walls)
rate_per_h = n / elapsed_h if elapsed_h > 0 else 0
# until tomorrow 08:00 Rome = 06:00 UTC
target = datetime.fromisoformat("2026-07-24T06:00:00+00:00")
hours_left = max(0, (target - now).total_seconds() / 3600)
est_more = rate_per_h * hours_left
print(
    json.dumps(
        {
            "elapsed_h": round(elapsed_h, 2),
            "attempts_completed": n,
            "rate_attempts_per_h": round(rate_per_h, 1),
            "hours_to_tomorrow_08_rome": round(hours_left, 2),
            "est_more_attempts_by_08": round(est_more),
            "est_total_attempts_touched_style": round(n + est_more),
            "note": "ALL 15 since restart went RETRY not terminal; terminal may stay near 6 unless outcomes improve",
        },
        indent=2,
    )
)
