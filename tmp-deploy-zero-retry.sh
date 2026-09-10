#!/usr/bin/env bash
# Deploy chromium fix + drain retry + patch systemd + smoke + restart 877
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
CP=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json
REAL_CHROME=/snap/chromium/current/usr/lib/chromium-browser/chrome

systemctl stop giorgio-revalidate || true
sleep 2

# Deploy patched files
install -m 644 /tmp/playwright-launch.ts "$APP/src/lib/sanita/playwright-launch.ts"
install -m 644 /tmp/revalidate-checkpoint-v3.mjs "$APP/scripts/revalidate-checkpoint-v3.mjs"
install -m 644 /tmp/production-revalidate-sanita-v3.mjs "$APP/scripts/production-revalidate-sanita-v3.mjs"
install -m 644 /tmp/test-stopship-no-tech-terminal.mjs "$APP/scripts/test-stopship-no-tech-terminal.mjs"
# optional control route if present
if [[ -f /tmp/control-route.ts ]]; then
  install -m 644 /tmp/control-route.ts "$APP/src/app/api/sanita/archive-revalidation/control/route.ts"
fi

# Patch systemd env to real chrome
UNIT=/etc/systemd/system/giorgio-revalidate.service
sed -i "s|PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=.*|PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=${REAL_CHROME}|" "$UNIT"
sed -i "s|CHROMIUM_PATH=.*|CHROMIUM_PATH=${REAL_CHROME}|" "$UNIT"
# ensure lines exist
grep -q 'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=' "$UNIT" || \
  sed -i "/Environment=PATH=/a Environment=PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=${REAL_CHROME}" "$UNIT"
grep -q 'CHROMIUM_PATH=' "$UNIT" || \
  sed -i "/Environment=PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/a Environment=CHROMIUM_PATH=${REAL_CHROME}" "$UNIT"
systemctl daemon-reload

# Drain retry queue → REVIEW
sed -i 's/\r$//' /tmp/tmp-drain-retry-queue.sh
bash /tmp/tmp-drain-retry-queue.sh "$CP"

# Local unit tests + PW smoke from app
cd "$APP"
node scripts/test-stopship-no-tech-terminal.mjs
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$REAL_CHROME"
export CHROMIUM_PATH="$REAL_CHROME"
npx tsx scripts/test-playwright-chromium-smoke.mjs

# Restart 877 preserved checkpoint
systemctl reset-failed giorgio-revalidate || true
systemctl start giorgio-revalidate
sleep 5
systemctl is-active giorgio-revalidate
python3 - <<'PY'
import json
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
print(json.dumps({
  'active_check': True,
  'terminal': len(cp.get('terminal') or {}),
  'retry': len(cp.get('retryQueue') or {}),
  'inProgress': len(cp.get('inProgress') or {}),
  'stats_retry': (cp.get('stats') or {}).get('retry'),
}, indent=2))
PY
grep -E 'PLAYWRIGHT|CHROMIUM' "$UNIT" | head -5
journalctl -u giorgio-revalidate -n 30 --no-pager | tail -30
