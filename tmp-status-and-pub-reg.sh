#!/usr/bin/env bash
set -euo pipefail
echo '=== SCAN ==='
systemctl is-active giorgio-revalidate || true
python3 <<'PY'
import json, collections, os, re, time, glob, csv, sqlite3, hashlib
from datetime import datetime, timezone

cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
term=cp.get('terminal') or {}
rq=cp.get('retryQueue') or {}
ip=cp.get('inProgress') or {}
by=collections.Counter(v.get('processingState') for v in term.values())
print(json.dumps({
  'terminal': len(term),
  'retry': len(rq),
  'inProgress': len(ip),
  'by_state': dict(by),
  'stats': cp.get('stats'),
  'updatedAt': cp.get('updatedAt'),
}, indent=2))

# published family in NEW run terminals
pub_new=[(k,v) for k,v in term.items() if re.search(r'PUBLISHED|SELF_INSURANCE', str(v.get('processingState') or ''), re.I)]
print('NEW_RUN_PUB_FAMILY', len(pub_new))
for k,v in pub_new[:15]:
  print(' ', k, v.get('processingState'), v.get('reasonCode'))

# LIVE V:PUB
con=sqlite3.connect('file:/opt/leadsniper/prisma/dev.db?mode=ro', uri=True)
con.row_factory=sqlite3.Row
live_pub=0
live_by_v=collections.Counter()
live_ps=collections.Counter()
for r in con.execute('SELECT evidence, policyFound FROM Lead'):
  ev=r['evidence'] or ''
  m=re.match(r'\[V:(\w+)\]', ev)
  live_by_v[m.group(1) if m else 'NO_V'] += 1
  if m and m.group(1)=='PUB':
    live_pub += 1
  ps=re.search(r'\[(?:PS|STATE):([^\]]+)\]', ev, re.I)
  if ps: live_ps[ps.group(1)] += 1
print('LIVE_V_PUB', live_pub)
print('LIVE_V_COUNTS', dict(live_by_v))
print('LIVE_STATE_sample', dict(live_ps.most_common(12)))
print('LIVE_SHA', hashlib.sha256(open('/opt/leadsniper/prisma/dev.db','rb').read()).hexdigest())

# baseline CSV compare
CSV='/opt/leadsniper-revalidate/app/docs/human-review/published-baseline-final/published-baseline.csv'
ids=[]
if os.path.isfile(CSV):
  with open(CSV, newline='', encoding='utf-8', errors='replace') as f:
    for row in csv.DictReader(f):
      if (row.get('verdict_storico') or '').upper()=='PUBLISHED' and row.get('leadId'):
        ids.append(row['leadId'])
else:
  ids=[r['id'] for r in con.execute("SELECT id, evidence FROM Lead") if re.match(r'\[V:PUB\]', r['evidence'] or '')]

live_reg=[]; shadow_reg=[]; confirmed=[]; inflight=[]; notyet=[]
for lid in ids:
  live=con.execute('SELECT companyName, evidence, policyFound FROM Lead WHERE id=?', (lid,)).fetchone()
  if not live:
    live_reg.append({'id':lid,'why':'missing'}); continue
  ev=live['evidence'] or ''
  ok = re.match(r'\[V:PUB\]', ev) or live['policyFound'] or re.search(r'PUBLISHED|SELF_INSURANCE', ev, re.I)
  if not ok:
    live_reg.append({'id':lid,'name':live['companyName'],'head':ev[:80]})
  # shadow
  if lid in term:
    ps=term[lid].get('processingState')
    if re.search(r'PUBLISHED|SELF_INSURANCE', ps or '', re.I):
      confirmed.append((lid,ps))
    elif ps=='HOT_VERIFIED':
      shadow_reg.append({'id':lid,'name':live['companyName'],'shadow':ps,'kind':'to_HOT'})
    else:
      shadow_reg.append({'id':lid,'name':live['companyName'],'shadow':ps,'kind':'other'})
  elif lid in rq or lid in ip:
    inflight.append(lid)
  else:
    notyet.append(lid)

print(json.dumps({
  'baseline_n': len(ids),
  'live_regression_count': len(live_reg),
  'live_regressions': live_reg[:20],
  'shadow_confirmed_pub': len(confirmed),
  'shadow_regressions': shadow_reg[:20],
  'shadow_regression_count': len(shadow_reg),
  'in_flight': len(inflight),
  'not_yet_in_877': len(notyet),
  'verdict_live': 'PASS' if not live_reg else 'FAIL',
}, indent=2, ensure_ascii=False))
con.close()
PY
echo '=== journal poison 60m ==='
journalctl -u giorgio-revalidate --since '60 min ago' --no-pager | grep -cEi 'ANALYZE_ERROR|Executable doesn|headless_shell' || true
journalctl -u giorgio-revalidate --since '30 min ago' --no-pager | grep -E 'lead_done' | tail -12 || true
