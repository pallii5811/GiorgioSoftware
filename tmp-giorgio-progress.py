#!/usr/bin/env python3
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

print("===CP===")
exec(open("/tmp/cp-status.py").read())

fp = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
cp = json.loads(fp.read_text())
ip = cp.get("inProgress") or {}
print("===FRONTIER===")
for lid, meta in ip.items():
    path = meta.get("frontierPath")
    if not path or not Path(path).exists():
        print(lid, "no frontier")
        continue
    con = sqlite3.connect(path)
    tables = [r[0] for r in con.execute("select name from sqlite_master where type='table'").fetchall()]
    print(lid, "tables", tables)
    for t in tables:
        try:
            cols = [r[1] for r in con.execute(f"pragma table_info({t})").fetchall()]
            if "state" in cols:
                rows = con.execute(f"select state, count(*) from {t} group by state").fetchall()
                print(" ", t, rows)
            else:
                n = con.execute(f"select count(*) from {t}").fetchone()[0]
                print(" ", t, "count", n)
        except Exception as e:
            print(" ", t, e)
    con.close()

print("===LOG_TAIL===")
log = Path("/opt/leadsniper-revalidate/logs/systemd-revalidate.log")
lines = log.read_text(errors="replace").splitlines()
# find last start
idx = 0
for i, line in enumerate(lines):
    if "revalidate_v3_start" in line:
        idx = i
for line in lines[idx:]:
    if any(k in line for k in ("lead_done", "worker_done", "frontier_fresh", "frontier_resume", "revalidate_v3_start", "error")):
        print(line[:500])
