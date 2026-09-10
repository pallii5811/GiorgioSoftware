#!/usr/bin/env bash
set -euo pipefail
echo "=== SERVICE ==="
systemctl is-active giorgio-revalidate
systemctl show giorgio-revalidate -p ActiveState -p SubState -p MainPID --no-pager

python3 <<'PY'
import json, collections, glob, os, re
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
print(json.dumps({
  'terminal': len(cp.get('terminal') or {}),
  'retry': len(cp.get('retryQueue') or {}),
  'inProgress': cp.get('inProgress'),
  'stats': cp.get('stats'),
  'sha': cp.get('testedCodeSha'),
}, indent=2, default=str))

# classify REVIEW reasons from checkpoint + result files
reasons=collections.Counter()
drained=0
for lid, meta in (cp.get('terminal') or {}).items():
  if meta.get('processingState')!='REVIEW_HUMAN':
    continue
  rc=str(meta.get('reasonCode') or '')
  if 'DRAIN' in rc or 'CLIENT_ZERO_RETRY' in rc or 'DRAIN_RETRY' in rc or 'DRAIN_IN_PROGRESS' in rc:
    drained += 1
    # extract original
    m=re.search(r'(?:DRAIN_RETRY|CLIENT_ZERO_RETRY|DRAIN_IN_PROGRESS):?\s*(.*)', rc)
    orig=(m.group(1) if m else rc)[:80].strip() or 'DRAINED'
    reasons['DRAINED:'+orig.split()[0] if orig else 'DRAINED'] += 1
    continue
  # try result file
  rf=f'/opt/leadsniper-revalidate/data/revalidation/results/{lid}.json'
  if os.path.exists(rf):
    try:
      r=json.load(open(rf))
      rr=str(r.get('reasonCode') or r.get('error') or r.get('processingState') or 'REVIEW')
      reasons[rr[:90]] += 1
      continue
    except Exception:
      pass
  reasons[rc[:90] or 'REVIEW_NO_REASON'] += 1

print('REVIEW_COUNT', sum(1 for v in (cp.get('terminal') or {}).values() if v.get('processingState')=='REVIEW_HUMAN'))
print('OF_WHICH_DRAINED_BY_ZERO_RETRY_POLICY', drained)
print('TOP_REVIEW_REASONS')
for k,n in reasons.most_common(20):
  print(f'  {n:3d}  {k}')
PY

echo "=== RECENT JOURNAL ==="
journalctl -u giorgio-revalidate --since '3 min ago' --no-pager | grep -E 'lead_done|boot|started|error|ANALYZE' | tail -20 || true
