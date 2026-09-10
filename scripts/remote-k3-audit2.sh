#!/usr/bin/env bash
set -euo pipefail
echo "RELEASE_REVAL=$(cat /opt/leadsniper-revalidate/app/RELEASE_SHA 2>/dev/null || echo missing)"
echo "RELEASE_UI=$(cat /opt/leadsniper/app/RELEASE_SHA 2>/dev/null || cat /opt/leadsniper/RELEASE_SHA 2>/dev/null || echo missing)"
sha256sum /opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker.mjs
sha256sum /opt/leadsniper-revalidate/app/src/lib/sanita/ocr.ts
test -f /opt/leadsniper/app/src/app/api/sanita/archive-revalidation/control/route.ts && echo UI_CONTROL_API=yes || echo UI_CONTROL_API=no
test -f /opt/leadsniper/app/src/components/sanita-leads.tsx && grep -c 'Avvia scansione\|btn-start\|archive-revalidation/control' /opt/leadsniper/app/src/components/sanita-leads.tsx || echo UI_BUTTONS=0
python3 <<'PY'
import json
from pathlib import Path
from collections import Counter
c=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
term=c.get("terminal") or {}
ps=Counter()
for v in term.values():
  ps[(v.get("processingState") if isinstance(v,dict) else "?")] += 1
print(json.dumps({
  "updatedAt": c.get("updatedAt"),
  "version": c.get("version"),
  "terminal": len(term),
  "retry": len(c.get("retryQueue") or {}),
  "inProgress": len(c.get("inProgress") or {}),
  "inProgressIds": list((c.get("inProgress") or {}).keys()),
  "stats": c.get("stats"),
  "terminalByPS": dict(ps),
}, indent=2))
PY
echo "locks=$(ls /opt/leadsniper-revalidate/data/revalidation/locks 2>/dev/null | wc -l)"
ps aux | grep -E 'revalidate-sanita|k3-revalidate|k3-micro' | grep -v grep || echo no_reval_procs
pm2 show leadsniper-ui 2>/dev/null | grep -E 'status|script path|exec cwd|pid|uptime' | head -20
# curl UI
for url in http://127.0.0.1:3000/sanita http://127.0.0.1:3000/api/sanita/archive-revalidation; do
  code=$(curl -sS -o /tmp/k3curl.out -w "%{http_code}" --max-time 8 "$url" || echo ERR)
  echo "GET $url -> $code"
done
# control endpoint present?
code=$(curl -sS -o /tmp/k3ctrl.out -w "%{http_code}" --max-time 8 http://127.0.0.1:3000/api/sanita/archive-revalidation/control || echo ERR)
echo "GET control -> $code"
head -c 400 /tmp/k3ctrl.out; echo
ls -lt /opt/leadsniper/logs 2>/dev/null | head -8 || true
ls -lt /opt/leadsniper-revalidate/logs 2>/dev/null | head -8 || true
echo AUDIT2_OK
