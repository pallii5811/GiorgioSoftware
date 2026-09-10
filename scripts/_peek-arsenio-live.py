#!/usr/bin/env python3
import json, sqlite3, os
from pathlib import Path
from collections import Counter

cp = json.loads(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read())
ip = cp.get("inProgress", {}).get("cmqp7cqya00011q5bkqf3ox8q")
print("inProgress", ip)
fp = (ip or {}).get("frontierPath")
if not fp:
    # newest arsenio frontier
    d = Path("/opt/leadsniper-revalidate/data/revalidation/frontiers")
    cands = sorted(d.glob("*cmqp7cqya*"), key=lambda p: p.stat().st_mtime, reverse=True)
    print("cands", [(p.name, p.stat().st_mtime, p.stat().st_size) for p in cands[:5]])
    fp = str(cands[0]) if cands else None
print("fp", fp, "exists", fp and os.path.exists(fp), "size", os.path.getsize(fp) if fp and os.path.exists(fp) else None)
if fp and os.path.exists(fp):
    con = sqlite3.connect(fp)
    con.row_factory = sqlite3.Row
    runs = list(con.execute("select * from CrawlRun"))
    print("runs", len(runs))
    for r in runs:
        print(dict(r))
    states = Counter(r[0] for r in con.execute("select state from CrawlFrontierNode"))
    print("states", dict(states))
    hosts = Counter()
    for (u, st) in con.execute("select canonicalUrl, state from CrawlFrontierNode"):
        from urllib.parse import urlparse
        hosts[(urlparse(u).hostname, st)] += 1
    print("host_state top", hosts.most_common(20))
    tb = list(con.execute("select canonicalUrl,lastError,discoverySource from CrawlFrontierNode where state='TECHNICAL_BLOCKED' limit 5"))
    print("tb sample", tb)
    con.close()
