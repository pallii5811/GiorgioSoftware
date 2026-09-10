#!/usr/bin/env python3
import sqlite3
from collections import Counter
from urllib.parse import urlparse

fp = "/opt/leadsniper-revalidate/data/revalidation/frontiers/reval-p1-cmqp7cqya00011q5bkqf3ox8q-1784767046766.sqlite"
con = sqlite3.connect(fp)
con.row_factory = sqlite3.Row
print("RUN", dict(con.execute("select * from CrawlRun").fetchone()))
print("--- TECHNICAL_BLOCKED ---")
for r in con.execute(
    "select canonicalUrl,parentUrl,discoverySource,state,httpStatus,lastError,relevance,retryCount from CrawlFrontierNode where state='TECHNICAL_BLOCKED'"
):
    print(dict(r))
print("--- EXCLUDED ---")
for r in con.execute(
    "select canonicalUrl,parentUrl,discoverySource,state,httpStatus,lastError,relevance,exclusionReason from CrawlFrontierNode where state='EXCLUDED'"
):
    print(dict(r))
print("--- hosts by state ---")
for st in ("COMPLETED", "EXCLUDED", "TECHNICAL_BLOCKED"):
    hosts = Counter()
    for (u,) in con.execute("select canonicalUrl from CrawlFrontierNode where state=?", (st,)):
        hosts[urlparse(u).hostname] += 1
    print(st, dict(hosts))
print("--- COMPLETED paths (sample) ---")
for (u,) in con.execute("select canonicalUrl from CrawlFrontierNode where state='COMPLETED' limit 20"):
    print(u)
con.close()
