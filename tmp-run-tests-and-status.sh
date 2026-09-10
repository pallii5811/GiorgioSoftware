#!/bin/bash
set -euo pipefail
cd /opt/leadsniper-revalidate/app
npx --yes tsx scripts/test-suite.mjs > /tmp/test-suite-out.txt 2>&1 || true
tail -80 /tmp/test-suite-out.txt
grep -E "PDF digitale|OCR|FAIL|PASSATI|Error|assert" /tmp/test-suite-out.txt | tail -40
echo "---"
python3 /tmp/tmp-peek-two-results.py
python3 - <<'PY'
import json
from pathlib import Path
cp=json.loads(Path('/opt/leadsniper-revalidate/data/stopship-retry11-rerun/checkpoint.json').read_text())
print('term',len(cp.get('terminal',{})),'retry',list(cp.get('retryQueue',{})),'ip',list(cp.get('inProgress',{})))
print('malzoni_term', cp.get('terminal',{}).get('cmqklex5g00b6108ejom1shk0'))
print('malzoni_rq', cp.get('retryQueue',{}).get('cmqklex5g00b6108ejom1shk0'))
PY
tail -n 20 /opt/leadsniper-revalidate/data/stopship-retry11-rerun/targeted.log
