#!/usr/bin/env python3
"""Dump DB facts for the 3 leads (website, piva, phone, evidence)."""
import json
import os
import sqlite3
from pathlib import Path

IDS = [
    "cmqktyimz000i111hygme29nh",
    "cmqklex5q00bh108eq9blm01k",
    "cmqoe7vww004aaa3v67rkgl4e",
]

# try shadow + product dbs
dbs = [
    "/opt/leadsniper-revalidate/shadow-revalidate.db",
    "/opt/leadsniper/prisma/dev.db",
    "/opt/leadsniper-revalidate/app/prisma/dev.db",
]
for db in dbs:
    if not Path(db).exists():
        print("missing", db)
        continue
    print("DB", db)
    con = sqlite3.connect(db)
    con.row_factory = sqlite3.Row
    cols = [r[1] for r in con.execute("pragma table_info(Lead)").fetchall()]
    print(" cols", cols[:30])
    for i in IDS:
        row = con.execute("select * from Lead where id=?", (i,)).fetchone()
        if not row:
            print(" ", i, "NOT FOUND")
            continue
        d = dict(row)
        keep = {
            k: d.get(k)
            for k in (
                "id",
                "companyName",
                "city",
                "region",
                "website",
                "phone",
                "email",
                "pec",
                "piva",
                "category",
                "verdict",
                "processingState",
                "osmId",
            )
            if k in d
        }
        print(json.dumps(keep, ensure_ascii=False))
    con.close()

RD = Path("/opt/leadsniper-revalidate/data/revalidation/results")
for i in IDS:
    p = RD / f"{i}.json"
    if not p.exists():
        continue
    r = json.load(open(p))
    print(
        "RESULT",
        i,
        r.get("companyName"),
        "web=",
        r.get("website"),
        "state=",
        r.get("processingState"),
        "reachable=",
        r.get("websiteReachable"),
    )
