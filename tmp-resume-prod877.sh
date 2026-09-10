#!/bin/bash
set -euo pipefail
# Resume production 877 — concurrency 1, APPLY_LIVE=0. Do not reset checkpoint.

systemctl stop giorgio-revalidate 2>/dev/null || true
sleep 1

# ensure stopship budgets drop-in present
cat > /etc/systemd/system/giorgio-revalidate.service.d/10-stopship-budgets.conf <<'EOF'
[Service]
Environment=APPLY_LIVE=0
Environment=DISABLE_LIVE_DB=true
Environment=TOTAL_WORKERS=1
Environment=REVALIDATE_CONCURRENCY=1
Environment=PER_HOST_CONCURRENCY=1
Environment=CRAWL_HTML_URL_CAP=100
Environment=CRAWL_RUN_MAX_WALL_CLOCK_MS=2700000
Environment=CRAWL_MAX_HTML_PER_SLICE=24
Environment=REVALIDATE_LEAD_WALL_MS=3300000
Environment=REVALIDATE_SLICE_WALL_MS=3300000
Environment=OCR_TIMEOUT_MS=180000
Environment=PDF_FETCH_TIMEOUT_MS=60000
Environment=MAX_DOCUMENT_RETRIES=3
Environment=REVALIDATE_MAX_RETRY=5
EOF
systemctl daemon-reload

python3 - <<'PY'
import hashlib, json
from datetime import datetime, timezone
from pathlib import Path
cp_path=Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
raw=cp_path.read_bytes()
sha=hashlib.sha256(raw).hexdigest()
cp=json.loads(raw)
# clear stale inProgress only
cleared=list((cp.get("inProgress") or {}).keys())
cp["inProgress"]={}
cp["updatedAt"]=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]+"Z"
tmp=cp_path.with_suffix(".json.tmp")
tmp.write_text(json.dumps(cp, ensure_ascii=False, indent=2), encoding="utf-8")
tmp.replace(cp_path)
print(json.dumps({
  "sha_before_clear_ip": sha,
  "sha_after": hashlib.sha256(cp_path.read_bytes()).hexdigest(),
  "terminal": len(cp.get("terminal") or {}),
  "retry": len(cp.get("retryQueue") or {}),
  "cleared_inProgress": cleared,
}, indent=2))
PY

# single flock parent via unit (unit should already use flock if configured)
systemctl start giorgio-revalidate
sleep 6
systemctl is-active giorgio-revalidate
systemctl show giorgio-revalidate -p ActiveEnterTimestamp --value
echo "===ENV==="
systemctl show giorgio-revalidate -p Environment --value | tr ' ' '\n' | grep -E 'APPLY_LIVE|CONCURRENCY|TOTAL_WORKERS|CRAWL_|REVALIDATE_LEAD|MAX_DOCUMENT|OCR_TIMEOUT' || true
echo "===LOG==="
tail -n 30 /opt/leadsniper-revalidate/logs/systemd-revalidate.log
