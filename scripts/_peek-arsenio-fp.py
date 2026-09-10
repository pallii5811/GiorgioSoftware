#!/usr/bin/env python3
import json, os, sqlite3
from pathlib import Path

fp = "/opt/leadsniper-revalidate/data/revalidation/frontiers/reval-p1-cmqp7cqya00011q5bkqf3ox8q-1784767046766.sqlite"
print("exists", os.path.exists(fp), "size", os.path.getsize(fp) if os.path.exists(fp) else None)
d = Path("/opt/leadsniper-revalidate/data/revalidation/frontiers")
for p in sorted(d.glob("*cmqp7cqya*")):
    print("frontier", p.name, p.stat().st_size)

con = sqlite3.connect(fp)
tables = [r[0] for r in con.execute("select name from sqlite_master where type='table'").fetchall()]
print("tables", tables)
for t in tables:
    cols = [r[1] for r in con.execute(f"pragma table_info({t})").fetchall()]
    n = con.execute(f"select count(*) from {t}").fetchone()[0]
    print(f"TABLE {t} n={n} cols={cols}")
    if n:
        row = con.execute(f"select * from {t} limit 1").fetchone()
        print(" sample_len", len(row) if row else 0)
        # if small table dump states
        if "state" in cols:
            dist = con.execute(f"select state, count(*) from {t} group by state").fetchall()
            print(" state_dist", dist)
        if "url" in cols and n <= 80:
            for r in con.execute(f"select * from {t}").fetchall():
                drow = dict(zip(cols, r))
                print(" NODE", drow.get("state"), drow.get("relevance"), drow.get("httpStatus") or drow.get("status"), (drow.get("url") or "")[:120], drow.get("error") or drow.get("lastError"))
con.close()

r = json.load(open("/opt/leadsniper-revalidate/data/revalidation/results/cmqp7cqya00011q5bkqf3ox8q.json"))
print("result_keys", sorted(r.keys()))
for k, v in r.items():
    lk = k.lower()
    if any(x in lk for x in ("frontier", "fail", "sitemap", "unresolved", "node", "error", "evidence")):
        if isinstance(v, str):
            print(k, "str", len(v), v[:400].replace("\n", " "))
        elif isinstance(v, list):
            print(k, "list", len(v), v[:3])
        elif isinstance(v, dict):
            print(k, "dict", list(v.keys())[:30])
        else:
            print(k, type(v).__name__, v)
