#!/usr/bin/env bash
set -uo pipefail
ID=cmqkld5t300av108e5rrr47s9
echo "=== WORKER TREE ==="
ps -o pid,etime,pcpu,pmem,rss,cmd -p 3495757 2>/dev/null || echo worker_gone
pgrep -P 3495757 -a 2>/dev/null | head -20
pgrep -af 'chrome-headless|chromium|pdftoppm|tesseract' | head -20
echo "=== FRONTIER ==="
FP=/opt/leadsniper-revalidate/data/revalidation/frontiers/reval-p1-${ID}-1784581423685.sqlite
ls -la "$FP" 2>/dev/null || ls -la /opt/leadsniper-revalidate/data/revalidation/frontiers/*${ID}* 2>/dev/null | tail -5
python3 - <<PY
import sqlite3, glob, os
paths=glob.glob("/opt/leadsniper-revalidate/data/revalidation/frontiers/*${ID}*")
print("paths", paths)
for p in paths:
  if not p.endswith(".sqlite"): continue
  try:
    c=sqlite3.connect(f"file:{p}?mode=ro", uri=True)
    tables=[r[0] for r in c.execute("select name from sqlite_master where type='table'").fetchall()]
    print("tables", tables[:20])
    for t in tables:
      if "node" in t.lower() or "url" in t.lower() or "crawl" in t.lower() or "frontier" in t.lower():
        try:
          n=c.execute(f"select count(*) from {t}").fetchone()[0]
          print(t, n)
        except Exception as e:
          print(t, e)
    c.close()
  except Exception as e:
    print("err", p, e)
PY
echo "=== RESULT TMP ==="
ls -la /opt/leadsniper-revalidate/data/revalidation/results/${ID}* 2>/dev/null || true
echo "=== STRACE SAMPLE (1s) ==="
timeout 2 strace -p 3495757 -e trace=network,file 2>&1 | tail -30 || true
