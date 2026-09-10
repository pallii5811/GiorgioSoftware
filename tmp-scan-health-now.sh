#!/usr/bin/env bash
set -euo pipefail
systemctl is-active giorgio-revalidate
python3 <<'PY'
import json, os, time, collections, glob
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
term=cp.get('terminal') or {}
rq=cp.get('retryQueue') or {}
ip=cp.get('inProgress') or {}
by=collections.Counter(v.get('processingState') for v in term.values())
print(json.dumps({
  'terminal': len(term),
  'retry': len(rq),
  'inProgress': len(ip),
  'inProgress_ids': list(ip.keys()),
  'by_state': dict(by),
  'stats': cp.get('stats'),
  'updatedAt': cp.get('updatedAt'),
  'sha': cp.get('testedCodeSha'),
}, indent=2))
# retry reasons
err=collections.Counter()
for v in rq.values():
  err[str(v.get('lastReason') or v.get('lastError') or '?')[:70]] += 1
print('RETRY_REASONS')
for k,n in err.most_common(10):
  print(f'  {n:3d}  {k}')
# recent result files last 15 min
now=time.time()
recent=[]
for f in glob.glob('/opt/leadsniper-revalidate/data/revalidation/results/*.json'):
  if f.endswith('.p1.json') or f.endswith('.p2.json'): continue
  mt=os.path.getmtime(f)
  if now-mt < 900:
    try:
      r=json.load(open(f))
      recent.append((mt, os.path.basename(f), r.get('processingState'), str(r.get('reasonCode') or r.get('error') or '')[:80]))
    except Exception: pass
recent.sort(reverse=True)
print('RECENT', len(recent))
for mt,name,ps,rc in recent[:10]:
  print(f'  {name} {ps} {rc}')
PY
echo '=== journal poison ==='
journalctl -u giorgio-revalidate --since '20 min ago' --no-pager | grep -cEi 'ANALYZE_ERROR|Executable doesn|headless_shell|PLAYWRIGHT_NO' || true
echo '(0 = clean)'
journalctl -u giorgio-revalidate --since '10 min ago' --no-pager | grep -E 'lead_done' | tail -8 || true
sha256sum /opt/leadsniper/prisma/dev.db | awk '{print "LIVE",$1}'
