#!/usr/bin/env python3
import json, re, sqlite3
from pathlib import Path

RD = Path("/opt/leadsniper-revalidate/data/revalidation/results")
CP = json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))

for i, name in [
    ("cmqp7cqya00011q5bkqf3ox8q", "Arsenio"),
    ("cmqktyimz000i111hygme29nh", "Malzoni"),
    ("cmqklex5q00bh108eq9blm01k", "Pini"),
]:
    r = json.load(open(RD / f"{i}.json"))
    ev = r.get("fullEvidence") or ""
    print("===", name, r.get("processingState"), r.get("reasonCode"), "wall", r.get("wallMs"), "fin", r.get("finishedAt"))
    print("tags", re.findall(r"\[(?:CRAWL_COMPLETE|FRONTIER|STATE|BV|IDENTITY|PS):[^\]]+\]", ev)[:12])
    print("ev", ev[:320].replace("\n", " "))
    print("cp term", CP.get("terminal", {}).get(i))
    print("cp retry", CP.get("retryQueue", {}).get(i))
    for fp in (r.get("frontierPaths") or [])[:2]:
        if not Path(fp).exists():
            print(" missing fp", fp)
            continue
        con = sqlite3.connect(fp)
        con.row_factory = sqlite3.Row
        run = con.execute(
            "select sitemapStatus,totalFailed,totalPending,totalCompleted,identityVerified,scopeVerified,stopReason from CrawlRun"
        ).fetchone()
        print(" fp", Path(fp).name, dict(run) if run else None)
        con.close()
    print()

COMM = {"PUBLISHED_CURRENT", "PUBLISHED_EXPIRED", "PUBLISHED_DATE_UNKNOWN", "SELF_INSURANCE_VERIFIED", "HOT_VERIFIED"}
sample = "cmqkld5rk009b108ekvol7g87,cmql4qrif000yc9w74e0tmpqt,cmql4d399000uc9w7yzw2dgac,cmqktyimz000i111hygme29nh,cmqklex5q00bh108eq9blm01k,cmql4d38u000kc9w7ng9zvakw,cmqkld5rt009m108ejllpw8nz,cmqmaor4t00389g5c2iuoauuw,cmqp7cqya00011q5bkqf3ox8q,cmqoe7vww004aaa3v67rkgl4e".split(
    ","
)
rows = []
for i in sample:
    t = CP.get("terminal", {}).get(i)
    r = CP.get("retryQueue", {}).get(i)
    st = (t or {}).get("processingState") or (r or {}).get("lastReason")
    web = None
    p = RD / f"{i}.json"
    if p.exists():
        try:
            web = json.load(open(p)).get("website")
        except Exception:
            pass
    rows.append((i, st, bool(web), (json.load(open(p)).get("companyName") if p.exists() else None)))

comm = [x for x in rows if x[1] in COMM]
reach = [x for x in rows if x[2]]
reach_comm = [x for x in reach if x[1] in COMM]
print("COMMERCIAL", len(comm), [x[1] for x in comm])
print(
    "RAW",
    len(comm) / 10,
    "REACH",
    len(reach_comm),
    "/",
    len(reach),
    "=",
    (len(reach_comm) / len(reach) if reach else 0),
)
for x in rows:
    print(x[0][-8:], x[3], x[1], "web" if x[2] else "NOWEB")
