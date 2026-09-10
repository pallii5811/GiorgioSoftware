#!/usr/bin/env python3
import sqlite3, os, json, glob

paths = [
    "/opt/leadsniper-revalidate/app/data/revalidation/frontiers/reval-p1-cmql4d38x000mc9w72hq8efcr-1784579576557.sqlite",
    "/opt/leadsniper-revalidate/data/revalidation/frontiers/reval-p1-cmqklex5f00b4108ebmk6b16f-1784587541751.sqlite",
]
for fp in paths:
    print("===", fp, "exists", os.path.isfile(fp))
    if not os.path.isfile(fp):
        continue
    con = sqlite3.connect(fp)
    print("CrawlRun", con.execute("SELECT id,state,urlCapReached,timeCapReached,sitemapStatus FROM CrawlRun").fetchall())
    print(
        "nodes",
        con.execute(
            "SELECT state, resourceType, COUNT(1) FROM CrawlFrontierNode GROUP BY state, resourceType"
        ).fetchall(),
    )
    con.close()

# live worker env
import subprocess

out = subprocess.check_output(["bash", "-lc", "pgrep -af production-revalidate-sanita-worker | head -5"]).decode()
print("workers", out)
pids = subprocess.check_output(["bash", "-lc", "pgrep -f production-revalidate-sanita-worker.mjs || true"]).decode().split()
for pid in pids[:2]:
    try:
        env = open(f"/proc/{pid}/environ", "rb").read().split(b"\0")
        for e in env:
            s = e.decode(errors="ignore")
            if any(k in s for k in ("CRAWL_HTML", "LEAD_WALL", "STRATEGY", "SLICE")):
                print(pid, s)
    except Exception as ex:
        print(pid, ex)

# gate progress
print("GATE", open("/tmp/retry20-gate.log").read()[-600:])
cp = json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
print("counts", {k: len(cp.get(k) or {}) for k in ("terminal", "retryQueue", "inProgress")})
