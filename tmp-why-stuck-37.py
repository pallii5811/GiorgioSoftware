#!/usr/bin/env python3
"""READ-ONLY: why terminal stuck at 37 — timeline + what workers do now."""
import json, re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

CP = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
LOG = Path("/opt/leadsniper-revalidate/logs/systemd-revalidate.log")
cp = json.loads(CP.read_text())
term = cp.get("terminal") or {}
rq = cp.get("retryQueue") or {}
inp = cp.get("inProgress") or {}
now = datetime.now(timezone.utc)

# Terminal finish timeline
fins = []
for lid, v in term.items():
    fa = v.get("finishedAt")
    if not fa:
        continue
    dt = datetime.fromisoformat(fa.replace("Z", "+00:00"))
    fins.append((dt, lid, v.get("processingState")))
fins.sort()

print("NOW_UTC", now.isoformat())
print("TERMINAL_N", len(term))
print("LAST_5_TERMINALS:")
for dt, lid, st in fins[-5:]:
    mins = int((now - dt).total_seconds() // 60)
    print(f"  {dt.isoformat()}  {st}  {lid}  ({mins} min ago)")

# hourly buckets today
by_hour = Counter()
for dt, _, st in fins:
    by_hour[dt.strftime("%Y-%m-%d %H:00")] += 1
print("TERMINALS_PER_HOUR:")
for h in sorted(by_hour):
    print(f"  {h} -> {by_hour[h]}")

# minutes since last terminal
if fins:
    stuck_min = int((now - fins[-1][0]).total_seconds() // 60)
    print("MINUTES_SINCE_LAST_TERMINAL", stuck_min)

# What are inProgress doing
print("IN_PROGRESS:")
for lid, meta in inp.items():
    started = meta.get("startedAt")
    try:
        sdt = datetime.fromisoformat(started.replace("Z", "+00:00"))
        run_min = int((now - sdt).total_seconds() // 60)
    except Exception:
        run_min = -1
    rq_meta = rq.get(lid) or {}
    print(json.dumps({
        "id": lid,
        "startedAt": started,
        "running_min": run_min,
        "strategy": meta.get("strategy"),
        "resumed": meta.get("resumed"),
        "pass": meta.get("pass"),
        "queue_reason": rq_meta.get("lastReason"),
        "queue_attempts": rq_meta.get("attempts"),
    }, ensure_ascii=False))

# Parse last ~3MB log for lead_done outcomes since last terminal
data = LOG.read_bytes()[-3_000_000:].decode("utf-8", "errors")
outcomes = Counter()
frontier_incomplete = 0
terminal_events = []
lead_done_n = 0
for line in data.splitlines():
    if '"event":"lead_done"' not in line:
        continue
    try:
        o = json.loads(line.strip())
    except Exception:
        continue
    lead_done_n += 1
    st = o.get("processingState") or "?"
    outcomes[st] += 1
    if st != "RETRY_PENDING" and not str(st).startswith("RETRY"):
        terminal_events.append(o)
    if o.get("reasonCode") == "FRONTIER_INCOMPLETE" or st == "RETRY_PENDING":
        # reason often only on worker_done
        pass

# worker_done reasonCode in tail
reasons = Counter()
same_lead = Counter()
for line in data.splitlines():
    if '"event":"worker_done"' not in line:
        continue
    try:
        o = json.loads(line.strip())
    except Exception:
        continue
    reasons[str(o.get("reasonCode") or o.get("processingState") or "?")] += 1
    same_lead[o.get("id")] += 1

print("LOG_TAIL_lead_done_outcomes", dict(outcomes.most_common(15)))
print("LOG_TAIL_worker_done_reasons", dict(reasons.most_common(12)))
print("LOG_TAIL_hottest_leads_worker_done", same_lead.most_common(8))
print("LOG_TAIL_non_retry_lead_done", len(terminal_events))
if terminal_events:
    print("last_non_retry_lead_done", terminal_events[-1])
