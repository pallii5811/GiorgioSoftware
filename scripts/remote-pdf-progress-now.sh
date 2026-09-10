#!/usr/bin/env bash
set -uo pipefail
# Check whether in-progress frontiers are completing PDFs (post priority fix)
python3 - <<'PY'
import json, sqlite3, glob
from pathlib import Path
cp=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
for lid, meta in (cp.get("inProgress") or {}).items():
  fps=sorted(glob.glob(f"/opt/leadsniper-revalidate/data/revalidation/frontiers/*{lid}*.sqlite"), key=lambda x: Path(x).stat().st_mtime, reverse=True)
  print("===", lid, "pass", (meta or {}).get("pass"))
  if not fps:
    print("no frontier"); continue
  p=fps[0]
  print("fp", Path(p).name, "mtime", Path(p).stat().st_mtime)
  c=sqlite3.connect(f"file:{p}?mode=ro", uri=True)
  print("pdf", c.execute("select state, count(*) from CrawlFrontierNode where resourceType='pdf' group by 1").fetchall())
  print("html_done", c.execute("select count(*) from CrawlFrontierNode where resourceType='html' and state='COMPLETED'").fetchone()[0])
  print("html_queued", c.execute("select count(*) from CrawlFrontierNode where resourceType='html' and state='QUEUED'").fetchone()[0])
  c.close()
PY
bash /tmp/remote-throughput-snapshot.sh | head -60
