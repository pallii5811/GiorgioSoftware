#!/usr/bin/env bash
# Read-only audit: UI vs revalidate vs checkpoint
set -euo pipefail
echo "=== SYSTEMD ==="
systemctl is-active giorgio-revalidate || true
systemctl is-active leadsniper || true
systemctl show giorgio-revalidate -p ActiveState,SubState,MainPID,FragmentPath,EnvironmentFiles --no-pager 2>/dev/null || true
systemctl show giorgio-revalidate -p Environment --no-pager 2>/dev/null | tr ' ' '\n' | grep -E 'PDFTOPPM|APPLY|DISCOVERY|CHECKPOINT|DATABASE|OCR|PATH=' | head -20 || true

echo "=== PM2 / UI ==="
pm2 list 2>/dev/null || true
# blue UI
if [ -d /opt/leadsniper ]; then
  echo "UI_ROOT=/opt/leadsniper"
  cat /opt/leadsniper/app/RELEASE_SHA 2>/dev/null || cat /opt/leadsniper/RELEASE_SHA 2>/dev/null || true
  ls -la /opt/leadsniper/app/package.json 2>/dev/null | head -1
fi
# find running next
ps aux | grep -E 'next|leadsniper|node.*server' | grep -v grep | head -15 || true

echo "=== REVALIDATE APP ==="
APP=/opt/leadsniper-revalidate/app
echo "RELEASE_SHA=$(cat $APP/RELEASE_SHA 2>/dev/null || echo missing)"
sha256sum $APP/scripts/production-revalidate-sanita-worker.mjs 2>/dev/null || true
sha256sum $APP/scripts/production-revalidate-sanita-v3.mjs 2>/dev/null || true
sha256sum $APP/src/lib/sanita/ocr.ts 2>/dev/null || true
test -f /etc/systemd/system/giorgio-revalidate.service.d/ocr.conf && echo "ocr_dropin=yes" || echo "ocr_dropin=no"
ls -la /opt/leadsniper-revalidate/logs/ 2>/dev/null | tail -15 || true

echo "=== CHECKPOINT ==="
CP=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json
python3 - <<'PY'
import json
from pathlib import Path
cp=Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
if not cp.exists():
  print("checkpoint MISSING"); raise SystemExit
c=json.loads(cp.read_text())
term=c.get("terminal") or {}
retry=c.get("retryQueue") or {}
ip=c.get("inProgress") or {}
print(json.dumps({
  "updatedAt": c.get("updatedAt"),
  "version": c.get("version"),
  "terminal": len(term),
  "retry": len(retry),
  "inProgress": len(ip),
  "inProgressIds": list(ip.keys())[:10],
  "stats": c.get("stats"),
}, indent=2))
# commercial terminals
from collections import Counter
ps=Counter()
for v in term.values():
  if isinstance(v, dict):
    ps[v.get("processingState") or "?"] += 1
  else:
    ps["scalar"] += 1
print("terminalByPS", dict(ps))
PY

echo "=== LOCKS / PROCS ==="
ls -la /opt/leadsniper-revalidate/data/revalidation/locks/ 2>/dev/null || true
ls -la /opt/leadsniper-revalidate/*.lock 2>/dev/null || true
ps aux | grep -E 'revalidate-sanita|giorgio-revalidate' | grep -v grep || echo "no revalidate procs"

echo "=== APPLY / BASELINE ==="
# env hints
grep -R "APPLY_LIVE\|DISABLE_LIVE\|STAGING_MODE" /etc/systemd/system/giorgio-revalidate* 2>/dev/null | head -20 || true
ls -la /opt/leadsniper-revalidate/data/baseline* 2>/dev/null | head -10 || true
ls -la /opt/leadsniper/data/baseline* 2>/dev/null | head -10 || true

echo "=== UI API SMOKE ==="
curl -sS -o /tmp/k3-api-health.txt -w "http=%{http_code}\n" http://127.0.0.1:3000/sanita 2>/dev/null || curl -sS -o /tmp/k3-api-health.txt -w "http=%{http_code}\n" http://127.0.0.1:3001/sanita 2>/dev/null || echo "ui_local_fail"
# try common ports
for p in 3000 3001 80 443; do
  code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:$p/sanita 2>/dev/null || echo 000)
  echo "port_$p=$code"
done

echo "=== RECENT LOGS ==="
ls -lt /opt/leadsniper-revalidate/logs/* 2>/dev/null | head -10
ls -lt /opt/leadsniper/logs/* 2>/dev/null | head -10 || true
ls -lt /tmp/ui-deploy* /tmp/k3* 2>/dev/null | head -20 || true
echo AUDIT_OK
