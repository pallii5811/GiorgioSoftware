#!/usr/bin/env bash
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
CACHE="$APP/.tesseract-cache"
# Tesseract resolves ./ita.special-words from process cwd (=APP)
for f in ita.special-words eng.special-words ita.user-words eng.user-words; do
  printf '\n' > "$CACHE/$f"
  printf '\n' > "$APP/$f"
done
install -m 0644 /tmp/k3-retry-patch/production-revalidate-sanita-v3.mjs "$APP/scripts/production-revalidate-sanita-v3.mjs"
install -m 0644 /tmp/k3-retry-patch/revalidate-checkpoint-v3.mjs "$APP/scripts/revalidate-checkpoint-v3.mjs"
install -m 0755 /tmp/k3-retry-patch/_frontier_inspect.py "$APP/scripts/_frontier_inspect.py"
install -m 0755 /tmp/k3-retry-patch/_frontier_clear_caps.py "$APP/scripts/_frontier_clear_caps.py"
# smoke inspect
python3 "$APP/scripts/_frontier_inspect.py" /opt/leadsniper-revalidate/app/data/revalidation/frontiers/reval-p1-cmql4d38x000mc9w72hq8efcr-1784579576557.sqlite
python3 <<'PY'
import json
from datetime import datetime, timezone
S='/opt/leadsniper-revalidate/data/k3-stopship/RETRY20_SAMPLE.json'
CP='/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'
s=json.load(open(S)); cp=json.load(open(CP)); rq=cp.get('retryQueue') or {}
term=cp.get('terminal') or {}
for r in s['records']:
  lid=r['leadId']
  if lid in term: continue
  meta=rq.get(lid) or {}
  meta['nextRetryAt']='1970-01-01T00:00:00.000Z'
  # bump attempts strategy toward fresh for empty frontiers
  meta['strategy']='resume_boost'
  meta['lastError']=meta.get('lastError') or r.get('initialError') or 'CRAWL_CAP'
  rq[lid]=meta
  (cp.get('inProgress') or {}).pop(lid, None)
cp['retryQueue']=rq
cp['updatedAt']=datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
json.dump(cp, open(CP,'w'), ensure_ascii=False, indent=2)
print('sample', len(s['records']), 'term', len(term), 'retry', len(rq))
PY
systemctl stop giorgio-revalidate
sleep 3
rm -f /opt/leadsniper-revalidate/revalidate.parent.lock || true
systemctl start giorgio-revalidate
sleep 8
echo "PID=$(systemctl show -p MainPID --value giorgio-revalidate)"
systemctl is-active giorgio-revalidate
pkill -f _poll-retry20-gate.py || true
sleep 1
nohup env GATE_TIMEOUT_S=1800 python3 -u /tmp/_poll-retry20-gate.py >/tmp/retry20-gate.log 2>&1 &
echo "POLL=$!"
sleep 45
grep -E 'frontier_force_fresh|frontier_fresh|frontier_clear_caps|lead_done' /opt/leadsniper-revalidate/logs/systemd-revalidate.log | tail -n 25
echo ---GATE---
tail -n 6 /tmp/retry20-gate.log
echo OCR_AND_FRESH_OK
