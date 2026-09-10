#!/usr/bin/env bash
set -euo pipefail
sleep 45
echo '=== status ==='
systemctl is-active giorgio-revalidate
python3 <<'PY'
import json, glob, os
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
print(json.dumps({
  'terminal': len(cp.get('terminal') or {}),
  'retry': len(cp.get('retryQueue') or {}),
  'inProgress': list((cp.get('inProgress') or {}).keys())[:5],
  'inProgress_n': len(cp.get('inProgress') or {}),
}, indent=2))
# recent result files
files=sorted(glob.glob('/opt/leadsniper-revalidate/data/revalidation/results/*.json'), key=os.path.getmtime, reverse=True)[:8]
for f in files:
  try:
    r=json.load(open(f))
  except Exception as e:
    print('bad', f, e); continue
  print(os.path.basename(f), 'ps=', r.get('processingState'), 'reason=', str(r.get('reasonCode') or r.get('error') or '')[:100])
PY
echo '=== journal errors ==='
journalctl -u giorgio-revalidate --since '2 min ago' --no-pager | grep -Ei 'ANALYZE_ERROR|Executable doesn|PLAYWRIGHT_NO|headless_shell|lead_done|retry_ceiling|error' | tail -40 || true
echo '=== resolve path in process ==='
# show parent cmdline env snippet if possible
tr '\0' '\n' < /proc/$(systemctl show -p MainPID --value giorgio-revalidate)/environ 2>/dev/null | grep -E 'PLAYWRIGHT|CHROMIUM' || true
