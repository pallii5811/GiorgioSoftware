#!/usr/bin/env bash
systemctl is-active giorgio-revalidate
python3 <<'PY'
import json
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
ip=cp.get('inProgress') or {}
print('terminal', len(cp.get('terminal') or {}))
print('retry', len(cp.get('retryQueue') or {}))
print('inProgress', len(ip), list(ip.keys())[:3])
print('sha', cp.get('testedCodeSha'))
PY
journalctl -u giorgio-revalidate -n 12 --no-pager | tail -12
