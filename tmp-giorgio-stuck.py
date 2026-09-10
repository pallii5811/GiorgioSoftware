#!/usr/bin/env python3
import json
import os
import sqlite3
from pathlib import Path

j = json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
print("updatedAt", j.get("updatedAt"))
print("stats", j.get("stats"))
print("inProgress", j.get("inProgress"))
print("terminal_n", len(j.get("terminal") or {}))
rq = j.get("retryQueue") or {}
print("retryQueue_n", len(rq))

cands = []
for root, dirs, files in os.walk("/opt/leadsniper"):
    if "node_modules" in root:
        continue
    for f in files:
        if f.endswith(".db") or f.endswith(".sqlite"):
            cands.append(os.path.join(root, f))
for root, dirs, files in os.walk("/opt/leadsniper-revalidate"):
    if "node_modules" in root or "/frontiers/" in root:
        continue
    for f in files:
        if f.endswith(".db") or f.endswith(".sqlite"):
            cands.append(os.path.join(root, f))
print("db_candidates", len(cands))


def name_for(lid: str):
    for d in cands:
        try:
            con = sqlite3.connect(d)
            cur = con.cursor()
            tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'")]
            for t in tables:
                if t.lower() not in ("lead", "leads"):
                    continue
                cols = [r[1] for r in cur.execute(f"PRAGMA table_info({t})")]
                namecol = "name" if "name" in cols else ("ragioneSociale" if "ragioneSociale" in cols else None)
                if not namecol or "id" not in cols:
                    continue
                row = cur.execute(f"SELECT {namecol} FROM {t} WHERE id=?", (lid,)).fetchone()
                con.close()
                if row:
                    return row[0]
            con.close()
        except Exception:
            continue
    return None


for lid, meta in rq.items():
    print(
        {
            "id": lid,
            "name": (name_for(lid) or "?")[:60],
            "attempts": meta.get("attempts"),
            "reason": meta.get("lastReason"),
            "next": meta.get("nextRetryAt"),
        }
    )

# reason histogram from attempts if present
atts = j.get("attempts") or {}
print("attempts_entries", len(atts) if isinstance(atts, dict) else type(atts))
