#!/usr/bin/env bash
set -uo pipefail
python3 - <<'PY'
import sqlite3
p="/opt/leadsniper-revalidate/data/revalidation/frontiers/reval-p1-cmqkld5t300av108e5rrr47s9-1784581423685.sqlite"
c=sqlite3.connect(f"file:{p}?mode=ro", uri=True)
print("by state+type", c.execute("select state, resourceType, count(*) from CrawlFrontierNode group by 1,2 order by 3 desc").fetchall())
print("pdf detail", c.execute("select state, count(*) from CrawlFrontierNode where resourceType='pdf' group by 1").fetchall())
print("completed html", c.execute("select count(*) from CrawlFrontierNode where state='COMPLETED' and resourceType='html'").fetchone())
print("run flags", c.execute("select * from CrawlRun").fetchall())
c.close()
PY
# wall env of worker
tr '\0' '\n' < /proc/3495757/environ 2>/dev/null | grep -E 'WALL|CRAWL|NODE|OUT_DIR|REVALIDATE' | sort
ps -o etime= -p 3495757 2>/dev/null
# timeout remaining: started ~45min ago
ps -o etime= -p 3495690 2>/dev/null
