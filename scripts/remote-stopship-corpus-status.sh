#!/usr/bin/env bash
set -euo pipefail
echo "=== corpus status ==="
systemctl is-active giorgio-revalidate || true
pid=$(cat /tmp/stopship-forensic/corpus12.pid 2>/dev/null || echo none)
echo "corpus_pid=$pid"
if [ "$pid" != "none" ] && kill -0 "$pid" 2>/dev/null; then echo corpus_alive=yes; else echo corpus_alive=no; fi
tail -30 /opt/leadsniper-revalidate/logs/stopship-corpus12.log || true
python3 - <<'PY'
import json
from pathlib import Path
c=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
ids=Path("/tmp/stopship-forensic/tech-ids.txt").read_text().strip().splitlines()
term=c.get("terminal") or {}
retry=c.get("retryQueue") or {}
ip=c.get("inProgress") or {}
def ps(v):
  if isinstance(v,str): return v.upper()
  return str((v or {}).get("processingState") or "").upper()
print(json.dumps({
  "terminal_total": len(term),
  "retry_total": len(retry),
  "inProgress": list(ip.keys()),
  "corpus_in_terminal": {i: ps(term[i]) for i in ids if i in term},
  "corpus_in_retry": {i: (retry[i] or {}).get("lastReason") for i in ids if i in retry},
  "corpus_in_progress": [i for i in ids if i in ip],
}, indent=2))
PY
sha256sum /opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker.mjs
