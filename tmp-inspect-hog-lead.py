#!/usr/bin/env python3
"""Perché il lead in corso non riprende il frontier e resta ore in coda."""
import glob, json, os, sqlite3
from collections import Counter
from pathlib import Path

CP = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
cp = json.loads(CP.read_text(encoding="utf-8"))
inp = cp.get("inProgress") or {}
rq = cp.get("retryQueue") or {}
att = cp.get("attempts") or {}

lid, meta = next(iter(inp.items()), (None, None))
print("running_lead", lid)
print("inProgress", json.dumps(meta, indent=2))
print("retryQueue_entry", json.dumps(rq.get(lid), indent=2, ensure_ascii=False) if lid in rq else "NOT_IN_RETRY")
print("attempts", att.get(lid))

if lid:
    files = sorted(
        glob.glob(f"/opt/leadsniper-revalidate/data/revalidation/frontiers/*{lid}*.sqlite"),
        key=os.path.getmtime,
    )
    print("frontier_files", len(files))
    for f in files:
        size_mb = round(os.path.getsize(f) / 1e6, 1)
        states = "?"
        try:
            con = sqlite3.connect(f"file:{f}?mode=ro", uri=True)
            tbls = [r[0] for r in con.execute("select name from sqlite_master where type='table'")]
            tbl = "FrontierNode" if "FrontierNode" in tbls else next((t for t in tbls if "node" in t.lower()), None)
            if tbl:
                cols = [r[1] for r in con.execute(f"pragma table_info({tbl})")]
                scol = "state" if "state" in cols else next((c for c in cols if "state" in c.lower()), None)
                rcol = next((c for c in cols if c.lower() in ("relevance", "priority")), None)
                if scol:
                    rows = con.execute(f"select {scol}, count(*) from {tbl} group by 1").fetchall()
                    states = dict(rows)
                if rcol:
                    rel = con.execute(
                        f"select {rcol}, {scol}, count(*) from {tbl} group by 1,2 order by 3 desc limit 8"
                    ).fetchall()
                    print("   relevance_breakdown", rel)
            con.close()
        except Exception as e:
            states = f"ERR {e}"
        print(f"  {os.path.basename(f)} {size_mb}MB mtime={os.path.getmtime(f):.0f} states={states}")

# how many leads have huge attempt counts / long-running history
print("\nattempts_distribution", dict(Counter(min(int(v or 0), 9) for v in att.values()).most_common()))
top = sorted(att.items(), key=lambda kv: -int(kv[1] or 0))[:10]
print("top_attempts", top)
