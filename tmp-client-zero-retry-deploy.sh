#!/usr/bin/env bash
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
CP=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json
TIP=e22daea1b17bb277913576f12bccf611ab5cd4f3

systemctl stop giorgio-revalidate || true
sleep 3

install -m 644 /tmp/revalidate-checkpoint-v3.mjs "$APP/scripts/revalidate-checkpoint-v3.mjs"
install -m 644 /tmp/production-revalidate-sanita-v3.mjs "$APP/scripts/production-revalidate-sanita-v3.mjs"
install -m 644 /tmp/test-stopship-no-tech-terminal.mjs "$APP/scripts/test-stopship-no-tech-terminal.mjs"

# Drain ALL retry + inProgress → REVIEW; stamp tip sha
python3 - "$CP" <<'PY'
import json, sys, datetime
path=sys.argv[1]
cp=json.load(open(path))
now=datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.%fZ')
moved=0
for bucket in ('retryQueue','inProgress'):
  d=cp.get(bucket) or {}
  for lid, meta in list(d.items()):
    if lid in (cp.get('terminal') or {}):
      del d[lid]; continue
    err=''
    if isinstance(meta, dict):
      err=f"{meta.get('lastError','')} {meta.get('lastReason','')}"
    cp.setdefault('terminal',{})[lid]={
      'finishedAt': now,
      'processingState': 'REVIEW_HUMAN',
      'newVerdict': 'REVIEW',
      'reasonCode': f'CLIENT_ZERO_RETRY:{str(err)[:140]}',
      'drainedFrom': bucket,
    }
    del d[lid]
    moved += 1
  cp[bucket]=d
cp['testedCodeSha']='WILL_SET'
cp['updatedAt']=now
cp.setdefault('stats',{})
cp['stats']['terminal']=len(cp.get('terminal') or {})
cp['stats']['retry']=0
cp['stats']['review']=int(cp['stats'].get('review') or 0)+moved
json.dump(cp, open(path,'w'), indent=2)
print(json.dumps({'moved':moved,'terminal':cp['stats']['terminal'],'retry':0,'inProgress':0}, indent=2))
PY

# set tip from RELEASE file if present after push stamp
NEW=$(cat "$APP/RELEASE_SHA" 2>/dev/null || echo "$TIP")
python3 - "$CP" "$NEW" <<'PY'
import json,sys
cp=json.load(open(sys.argv[1]))
cp['testedCodeSha']=sys.argv[2].strip()
json.dump(cp, open(sys.argv[1],'w'), indent=2)
print('testedCodeSha', cp['testedCodeSha'])
PY

cd "$APP"
node scripts/test-stopship-no-tech-terminal.mjs
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/snap/chromium/current/usr/lib/chromium-browser/chrome
export CHROMIUM_PATH="$PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"
npx tsx scripts/test-playwright-chromium-smoke.mjs

systemctl reset-failed giorgio-revalidate || true
systemctl start giorgio-revalidate
sleep 8
systemctl is-active giorgio-revalidate
python3 <<'PY'
import json
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
assert len(cp.get('retryQueue') or {})==0, cp.get('retryQueue')
print(json.dumps({
  'terminal': len(cp.get('terminal') or {}),
  'retry': len(cp.get('retryQueue') or {}),
  'inProgress': len(cp.get('inProgress') or {}),
  'hot': (cp.get('stats') or {}).get('hot'),
  'pub': (cp.get('stats') or {}).get('pub'),
  'review': (cp.get('stats') or {}).get('review'),
  'testedCodeSha': cp.get('testedCodeSha'),
  'live_db_note': 'checked separately',
}, indent=2))
PY
sha256sum /opt/leadsniper/prisma/dev.db | awk '{print "LIVE_DB",$1}'
journalctl -u giorgio-revalidate --since '30 sec ago' --no-pager | tail -25
