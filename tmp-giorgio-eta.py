#!/usr/bin/env python3
"""Estimate throughput from revalidate log since last start."""
from __future__ import annotations

import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

log = Path("/opt/leadsniper-revalidate/logs/systemd-revalidate.log")
lines = log.read_text(errors="replace").splitlines()

# last start
start_i = 0
for i, line in enumerate(lines):
    if '"event":"revalidate_v3_start"' in line:
        start_i = i

start_meta = {}
try:
    start_meta = json.loads(lines[start_i])
except Exception:
    pass

done = []
states = Counter()
for line in lines[start_i:]:
    if '"event":"lead_done"' not in line:
        continue
    try:
        ev = json.loads(line)
    except Exception:
        continue
    done.append(ev)
    states[ev.get("processingState") or ev.get("kind") or "?"] += 1

cp = json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
term = len(cp.get("terminal") or {})
retry = len(cp.get("retryQueue") or {})
ip = cp.get("inProgress") or {}
parked = sum(1 for m in (cp.get("retryQueue") or {}).values() if m.get("parkReason"))

# wall time since start from journal or process
import subprocess

try:
    active = subprocess.check_output(
        ["systemctl", "show", "giorgio-revalidate", "-p", "ActiveEnterTimestamp", "--value"],
        text=True,
    ).strip()
except Exception as e:
    active = str(e)

now = datetime.now(timezone.utc)
print(
    json.dumps(
        {
            "now_utc": now.isoformat(),
            "service_active_since": active,
            "start_event": start_meta,
            "lead_done_since_start": len(done),
            "states_since_start": dict(states),
            "checkpoint": {
                "terminal": term,
                "retry": retry,
                "parked": parked,
                "inProgress_ids": list(ip.keys()),
                "updatedAt": cp.get("updatedAt"),
            },
            "last_5_lead_done": done[-5:],
        },
        indent=2,
        default=str,
    )
)

# frontier progress for in-progress
for lid, meta in ip.items():
    path = meta.get("frontierPath")
    if not path or not Path(path).exists():
        continue
    import sqlite3

    con = sqlite3.connect(path)
    rows = con.execute(
        "select state, count(*) from CrawlFrontierNode group by state"
    ).fetchall()
    run = con.execute("select state from CrawlRun").fetchall()
    started = meta.get("startedAt")
    print("FRONTIER", lid, "startedAt", started, "run", run, "nodes", rows)
    con.close()
