#!/bin/bash
set -euo pipefail
pkill -TERM -f "production-revalidate-sanita-v3.mjs" 2>/dev/null || true
pkill -TERM -f "production-revalidate-sanita-worker.mjs" 2>/dev/null || true
sleep 2
pkill -KILL -f "production-revalidate-sanita-v3.mjs" 2>/dev/null || true
pkill -KILL -f "production-revalidate-sanita-worker.mjs" 2>/dev/null || true
rm -f /opt/leadsniper-revalidate/data/stopship-retry11-rerun/targeted.parent.lock || true

SHA=e99986c65b467dc2933000177848614b7d93129d
echo "$SHA" > /opt/leadsniper-revalidate/app/RELEASE_SHA
echo "$SHA" > /opt/leadsniper/RELEASE_SHA

# Build UI (real node_modules)
cd /opt/leadsniper
npm run build > /tmp/ui-build-out.txt 2>&1 && echo UI_BUILD_OK || {
  echo "retry next build --webpack";
  npx next build --webpack > /tmp/ui-build-out.txt 2>&1 && echo UI_BUILD_OK || {
    echo UI_BUILD_FAIL; tail -60 /tmp/ui-build-out.txt; exit 1;
  }
}

cd /opt/leadsniper-revalidate/app
npx --yes tsx scripts/test-ocr-contract.mjs > /tmp/ocr-contract.txt 2>&1 || true
npx --yes tsx scripts/test-ocr-pdftoppm-resolver.mjs > /tmp/ocr-pdftoppm.txt 2>&1 || true
echo OCR_CONTRACT_LINES=$(wc -l < /tmp/ocr-contract.txt)
tail -25 /tmp/ocr-contract.txt
echo OCR_PDFTOPPM_LINES=$(wc -l < /tmp/ocr-pdftoppm.txt)
tail -25 /tmp/ocr-pdftoppm.txt

python3 - <<'PY'
import json, hashlib
from pathlib import Path
cp=json.loads(Path('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json').read_text())
print('prod_keys', list(cp.keys())[:15])
print('prod_term', len(cp.get('terminal') or {}))
print('prod_retry', len(cp.get('retryQueue') or {}))
print('prod_ip', len(cp.get('inProgress') or {}))
print('DB', hashlib.sha256(Path('/opt/leadsniper/prisma/dev.db').read_bytes()).hexdigest())
print('CP', hashlib.sha256(Path('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json').read_bytes()).hexdigest())
print('RELEASE', Path('/opt/leadsniper-revalidate/app/RELEASE_SHA').read_text().strip())
# targeted snap
t=json.loads(Path('/opt/leadsniper-revalidate/data/stopship-retry11-rerun/checkpoint.json').read_text())
print('tgt_term', len(t.get('terminal') or {}), 'retry', len(t.get('retryQueue') or {}), 'ip', len(t.get('inProgress') or {}))
for lid, name in [
 ('cmqklex5g00b6108ejom1shk0','malzoni'),
 ('cmqmaf02a001k9g5crmkdun0w','medicanova')]:
  r=json.loads(Path(f'/opt/leadsniper-revalidate/data/stopship-retry11-rerun/results/{lid}.json').read_text())
  print(name, r.get('processingState'), r.get('reasonCode'))
PY

# Start 877 — APPLY_LIVE=0 via drop-in, concurrency=1, flock unique, no reset
systemctl daemon-reload
systemctl stop giorgio-revalidate || true
# confirm no reset of checkpoint
systemctl start giorgio-revalidate
sleep 6
systemctl is-active giorgio-revalidate
# confirm env
tr '\0' '\n' < /proc/$(systemctl show -p MainPID --value giorgio-revalidate)/environ 2>/dev/null | grep -E 'APPLY_LIVE|REVALIDATE_CONCURRENCY|REVALIDATE_CHECKPOINT|RELEASE|GIT_HEAD' || true
tail -n 15 /opt/leadsniper-revalidate/logs/systemd-revalidate.log
