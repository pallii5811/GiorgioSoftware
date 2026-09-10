#!/bin/bash
set -euo pipefail
SHA=fe28b759a7e2978c033815a3920f538ba585539d
systemctl stop giorgio-revalidate || true
pkill -KILL -f production-revalidate-sanita 2>/dev/null || true
rm -f /opt/leadsniper-revalidate/data/stopship-retry11-rerun/targeted.parent.lock || true
cp /tmp/self-insurance.ts /opt/leadsniper-revalidate/app/src/lib/sanita/
cp /tmp/scan-engine.ts /opt/leadsniper-revalidate/app/src/lib/sanita/
cp /tmp/self-insurance.ts /opt/leadsniper/src/lib/sanita/
cp /tmp/scan-engine.ts /opt/leadsniper/src/lib/sanita/
echo "$SHA" > /opt/leadsniper-revalidate/app/RELEASE_SHA
echo "$SHA" > /opt/leadsniper/RELEASE_SHA
systemctl daemon-reload
systemctl start giorgio-revalidate
sleep 5
echo ACTIVE=$(systemctl is-active giorgio-revalidate)
echo RELEASE=$(cat /opt/leadsniper-revalidate/app/RELEASE_SHA)
tr '\0' '\n' < /proc/$(systemctl show -p MainPID --value giorgio-revalidate)/environ | grep -E 'APPLY_LIVE|REVALIDATE_CONCURRENCY|CHECKPOINT' || true
python3 - <<'PY'
import json,hashlib
from pathlib import Path
cp=json.loads(Path('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json').read_text())
print('877_term', len(cp.get('terminal') or {}))
print('877_retry', len(cp.get('retryQueue') or {}))
print('877_ip', len(cp.get('inProgress') or {}))
j=json.loads(Path('/opt/leadsniper-revalidate/data/stopship-retry11-rerun/results/cmqklex5g00b6108ejom1shk0.json').read_text())
print('MALZONI', j.get('processingState'))
print('PAGE', j.get('evidencePage'))
print('EXCERPT', j.get('evidenceExcerpt'))
print('URL', j.get('policyUrl'))
print('HASH', j.get('documentSha256'))
ev=json.loads(Path('/opt/leadsniper-revalidate/data/stopship-retry11-rerun/TARGETED16_STRICT_REPORT.json').read_text())
print('EVAL_PASS', ev.get('PASS'), 'TERM', ev.get('TARGETED_TERMINAL'), 'RETRY', ev.get('TARGETED_RETRY'), 'AUDIT', ev.get('SOURCE_AUDIT'))
PY
tail -n 10 /opt/leadsniper-revalidate/logs/systemd-revalidate.log
