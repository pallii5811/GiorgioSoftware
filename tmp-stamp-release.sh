#!/usr/bin/env bash
set -euo pipefail
SHA=e22daea7$(git -C /opt/leadsniper-revalidate/app rev-parse HEAD 2>/dev/null || true)
# app has no git — stamp from known tip
TIP=e22daea
# resolve full sha from remote if possible
FULL=$(curl -fsSL "https://api.github.com/repos/pallii5811/GiorgioSoftware/commits/k3/stopship-complete-engine-20260722" 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin).get("sha",""))' || true)
if [[ -n "$FULL" ]]; then
  echo "$FULL" > /opt/leadsniper-revalidate/app/RELEASE_SHA
else
  echo "e22daea" > /opt/leadsniper-revalidate/app/RELEASE_SHA
fi
# also update checkpoint testedCodeSha only if safe (metadata)
python3 <<'PY'
import json
cp_path='/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'
cp=json.load(open(cp_path))
print(json.dumps({
  'service': True,
  'terminal': len(cp.get('terminal') or {}),
  'retry': len(cp.get('retryQueue') or {}),
  'inProgress': len(cp.get('inProgress') or {}),
  'hot': (cp.get('stats') or {}).get('hot'),
  'pub': (cp.get('stats') or {}).get('pub'),
  'review': (cp.get('stats') or {}).get('review'),
  'testedCodeSha_cp': cp.get('testedCodeSha'),
}, indent=2))
PY
echo -n 'RELEASE_SHA='; cat /opt/leadsniper-revalidate/app/RELEASE_SHA
echo
systemctl is-active giorgio-revalidate
sha256sum /opt/leadsniper/prisma/dev.db | awk '{print "LIVE_DB",$1}'
# confirm no snap/bin in unit
grep CHROMIUM /etc/systemd/system/giorgio-revalidate.service
journalctl -u giorgio-revalidate --since '15 min ago' --no-pager | grep -cEi 'ANALYZE_ERROR|Executable doesn|headless_shell' || true
echo "engine_error_hits_above (0 expected)"
