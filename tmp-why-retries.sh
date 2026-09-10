#!/bin/bash
set -euo pipefail
python3 <<'PY'
import json
from pathlib import Path
from collections import Counter
cp=json.loads(Path('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json').read_text())
rq=cp.get('retryQueue') or {}
print('retry_n', len(rq))
reasons=Counter()
for lid,m in rq.items():
  reasons[str(m.get('lastReason') or m.get('lastError') or '?')] += 1
print('reasons', dict(reasons.most_common()))
# top attempts
rows=sorted(((int(m.get('attempts') or 0), lid, m.get('lastReason'), m.get('lastError')) for lid,m in rq.items()), reverse=True)[:12]
print('top_attempts:')
for a,lid,r,e in rows:
  print(a, lid, r, str(e)[:80] if e else None)
# sample result files for ANALYZE_ERROR
res=Path('/opt/leadsniper-revalidate/data/revalidation/results')
n=0
for lid,m in rq.items():
  if 'ANALYZE' in str(m.get('lastReason') or ''):
    p=res/f'{lid}.json'
    if p.exists():
      j=json.loads(p.read_text())
      print('SAMPLE', lid, {k:j.get(k) for k in ('processingState','reasonCode','errorClass','error','stage','failingUrl')})
      ev=(j.get('fullEvidence') or j.get('evidence') or '')[:180]
      print('EV', ev)
      n+=1
      if n>=5: break
PY
echo '--- LOG ANALYZE/TIMEOUT last ---'
grep -E 'ANALYZE_ERROR|LEAD_WALL|OCR_TIMEOUT|WORKER_SIGTERM|reasonCode' /opt/leadsniper-revalidate/logs/systemd-revalidate.log | tail -40
