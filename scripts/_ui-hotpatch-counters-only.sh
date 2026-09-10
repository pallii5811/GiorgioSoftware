#!/usr/bin/env bash
# UI/API only: patch archive-revalidation counters on blue. NEVER touch giorgio-revalidate.
set -euo pipefail
APP=/opt/leadsniper
SRC="${1:?local staged file path required}"

echo "=== PRE ==="
systemctl is-active giorgio-revalidate || true
MAINPID=$(systemctl show -p MainPID --value giorgio-revalidate)
echo "REVAL_MAINPID=$MAINPID"
sha256sum /opt/leadsniper-revalidate/data/revalidation/checkpoint.json | tee /tmp/cp-ui-before.sha
test -f "$SRC"
install -m 0644 "$SRC" "$APP/src/app/api/sanita/archive-revalidation/route.ts"
printf 'e9ceff6-counters\n' > "$APP/RELEASE_SHA_UI_COUNTERS"

cd "$APP"
export DATABASE_URL='file:/opt/leadsniper/prisma/dev.db'
export SCAN_ENGINE_LOCAL=1
export NODE_ENV=production
npm run build
pm2 restart leadsniper-ui --update-env
sleep 6

echo "=== POST ==="
systemctl is-active giorgio-revalidate || true
MAINPID2=$(systemctl show -p MainPID --value giorgio-revalidate)
echo "REVAL_MAINPID_AFTER=$MAINPID2"
test "$MAINPID" = "$MAINPID2"
sha256sum /opt/leadsniper-revalidate/data/revalidation/checkpoint.json | tee /tmp/cp-ui-after.sha
diff -u /tmp/cp-ui-before.sha /tmp/cp-ui-after.sha
curl -sS --max-time 20 'http://127.0.0.1:3000/api/sanita/archive-revalidation' | python3 -c '
import json,sys
j=json.load(sys.stdin)
need=["terminalCompleted","certifiedCurrentRun","reviewCurrent","otherNonCommercialTerminal","technicalBlockedFinal","selfInsurance","published","hot"]
print({k:j.get(k) for k in need})
c=j.get("certifiedCurrentRun") or 0
r=j.get("reviewCurrent") or 0
o=j.get("otherNonCommercialTerminal") or 0
t=j.get("technicalBlockedFinal") or 0
term=j.get("terminalCompleted") or 0
print("sum", c+r+o+t, "terminal", term, "ok", c+r+o+t==term)
'
echo HOTPATCH_COUNTERS_OK
