#!/bin/bash
set -euo pipefail
python3 /tmp/stopship-sync2/tmp-prep-retry11-rerun.py
cp /tmp/stopship-sync2/tmp-run-retry11-rerun.sh /tmp/run-retry11-rerun.sh
chmod +x /tmp/run-retry11-rerun.sh
nohup bash /tmp/run-retry11-rerun.sh >/opt/leadsniper-revalidate/data/stopship-retry11-rerun/nohup.out 2>&1 &
echo "PID:$!"
sleep 15
echo "===SERVICE==="
systemctl is-active giorgio-revalidate || true
echo "===LOG==="
head -n 50 /opt/leadsniper-revalidate/data/stopship-retry11-rerun/targeted.log || cat /opt/leadsniper-revalidate/data/stopship-retry11-rerun/nohup.out || true
python3 - <<'PY'
import hashlib, json
from pathlib import Path
b=json.loads(Path('/opt/leadsniper-revalidate/data/stopship-retry11-rerun/baseline.json').read_text())
p=Path('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json')
print(json.dumps({
  'prod_unchanged': hashlib.sha256(p.read_bytes()).hexdigest()==b['prodCheckpointSha'],
  'db_unchanged': hashlib.sha256(Path(b['dbPath']).read_bytes()).hexdigest()==b['dbSha'],
  'prodSha': b['prodCheckpointSha'],
  'n': b['n'],
}, indent=2))
PY
