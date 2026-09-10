#!/usr/bin/env bash
# Immediate stop of corpus-12 one-shot. Preserve checkpoint/results. Do NOT start 877.
set -euo pipefail
OUT=/tmp/stopship-forensic
CP=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json
PID_FILE=$OUT/corpus12.pid

echo "=== STOP CORPUS ==="
systemctl is-active giorgio-revalidate || true
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  echo "corpus_pid=$PID"
  if kill -0 "$PID" 2>/dev/null; then
    # SIGTERM to flock parent and children
    kill -TERM "$PID" 2>/dev/null || true
    # also terminate worker children
    pkill -TERM -P "$PID" 2>/dev/null || true
    pkill -TERM -f "production-revalidate-sanita-v3.mjs" 2>/dev/null || true
    pkill -TERM -f "production-revalidate-sanita-worker.mjs" 2>/dev/null || true
  fi
fi

for i in $(seq 1 40); do
  alive=0
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then alive=1; fi
  ip=$(python3 -c "import json;c=json.load(open('$CP'));print(len(c.get('inProgress') or {}))")
  echo "t=${i}s parent_alive=$alive inProgress=$ip"
  if [ "$alive" = "0" ]; then
    break
  fi
  sleep 3
done

# Requeue any orphan inProgress
python3 - <<'PY'
import json
from datetime import datetime, timezone
from pathlib import Path
cp_path=Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
c=json.loads(cp_path.read_text())
ip=c.get("inProgress") or {}
rq=c.get("retryQueue") or {}
moved=[]
now=datetime.now(timezone.utc).isoformat()
for lid, meta in list(ip.items()):
    entry = meta if isinstance(meta, dict) else {"raw": meta}
    rq[lid]={
      **(rq.get(lid) if isinstance(rq.get(lid), dict) else {}),
      **entry,
      "requeuedAt": now,
      "requeueReason": "midrun_stop_ocr_renderer_missing",
      "nextRetryAt": now,
      "operational": True,
    }
    del ip[lid]
    moved.append(lid)
c["inProgress"]=ip
c["retryQueue"]=rq
c["updatedAt"]=now
tmp=cp_path.with_suffix(".json.tmp")
tmp.write_text(json.dumps(c, ensure_ascii=False, indent=2), encoding="utf-8")
tmp.replace(cp_path)
print(json.dumps({"moved": moved, "inProgress": len(ip), "retry": len(rq), "terminal": len(c.get("terminal") or {})}, indent=2))
PY

sha256sum /opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker.mjs
# verify OCR toolchain on host (diagnostic only)
echo "=== OCR TOOLCHAIN ==="
which pdftoppm || true
pdftoppm -v 2>&1 | head -1 || true
ls -la /usr/bin/pdftoppm 2>/dev/null || true
echo "PDFTOPPM_PATH=${PDFTOPPM_PATH:-unset}"
echo "TESSDATA_PREFIX check:"; ls /opt/leadsniper-revalidate/app/.tesseract-cache 2>/dev/null | head -5 || true
echo CORPUS_STOPPED
