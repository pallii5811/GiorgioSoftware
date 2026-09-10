#!/bin/bash
set -euo pipefail
OLD=b09d8495-721d-4c62-802d-e6dd9464696f
echo "=== OLD JOB ==="
if [ -f "/opt/leadsniper/data/sanita-jobs/${OLD}.json" ]; then
  python3 -c "import json; j=json.load(open('/opt/leadsniper/data/sanita-jobs/${OLD}.json')); print('status',j.get('status'),'pid',j.get('pid'),'cancel',j.get('cancelRequested'))"
else
  echo "missing"
fi
echo "=== PIDS for old job ==="
pgrep -af sanita-job-runner || echo none
echo "=== ACTIVE JOBS API ==="
curl -sS 'http://127.0.0.1:3000/api/sanita/jobs?active=1'
echo
echo "=== LOCKS ==="
test -f /opt/leadsniper/.live-scan.lock && cat /opt/leadsniper/.live-scan.lock || echo no_live_scan_lock
test -d /opt/leadsniper/.scan-locks && ls -la /opt/leadsniper/.scan-locks || echo no_scan_locks
echo "=== REVAL ==="
systemctl is-active giorgio-revalidate || true
sha256sum /opt/leadsniper-revalidate/data/revalidation/checkpoint.json
cat /opt/leadsniper/RELEASE_SHA
