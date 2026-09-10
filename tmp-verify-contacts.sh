#!/bin/bash
set -euo pipefail
# Verify live commercial join source + CSV fields contract via results API enrichment path
curl -s 'http://127.0.0.1:3000/api/sanita?includePending=1&includeAll=1' -o /tmp/sanita_all.json
python3 <<'PY'
import json
j=json.load(open('/tmp/sanita_all.json'))
leads=j.get('leads') or j.get('items') or j
if isinstance(j, dict) and 'leads' not in j and 'items' not in j:
  # maybe {data:[...]} or raw list
  leads=j.get('data') or j
if not isinstance(leads, list):
  print('KEYS', list(j.keys())[:20] if isinstance(j, dict) else type(j))
  leads=[]
want={'cmqkld5s2009y108ejvgl7m92':'Angela','cmqklex5q00bh108eq9blm01k':'Pini','cmqktyimz000i111hygme29nh':'Malzoni'}
by={str(x.get('id')):x for x in leads if isinstance(x, dict)}
print('LIVE_N', len(by))
for i,label in want.items():
  L=by.get(i) or {}
  print(label, 'website=',L.get('website'), 'phone=',L.get('phone'), 'email=',L.get('email'), 'pec=',L.get('pec'), 'piva=',L.get('piva'), 'cat=',L.get('category'), 'city=',L.get('city'), 'status=',L.get('status'))
PY
# flock uniqueness
echo FLOCK_HOLDERS=$(pgrep -c -f 'revalidate.parent.lock' || true)
echo APPLY=$(grep APPLY_LIVE /etc/systemd/system/giorgio-revalidate.service.d/00-safety.conf)
# evidence route in UI build
ls /opt/leadsniper/.next/server/app/api/sanita/archive-revalidation/evidence-file/route.js 2>/dev/null && echo EVIDENCE_ROUTE_BUILT
# git tip on server
cat /opt/leadsniper-revalidate/app/RELEASE_SHA 2>/dev/null || true
cd /opt/leadsniper && git rev-parse HEAD 2>/dev/null || true
