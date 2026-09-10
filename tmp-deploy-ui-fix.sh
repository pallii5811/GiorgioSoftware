#!/bin/bash
# Deploy UI semantic fix + control systemd + enable paused service. NO full 877 start.
set -euo pipefail
UI=/opt/leadsniper
APP=/opt/leadsniper-revalidate/app

# APPLY_LIVE=0 drop-in
mkdir -p /etc/systemd/system/giorgio-revalidate.service.d
cat >/etc/systemd/system/giorgio-revalidate.service.d/00-safety.conf <<'EOF'
[Service]
Environment=APPLY_LIVE=0
Environment=DISABLE_LIVE_DB=true
Environment=PER_HOST_CONCURRENCY=1
Environment=TOTAL_WORKERS=1
Environment=REVALIDATE_CONCURRENCY=1
EOF
systemctl daemon-reload
systemctl enable giorgio-revalidate
systemctl stop giorgio-revalidate || true

# Copy patched UI sources
install -m 644 /tmp/sanita-leads.tsx "$UI/src/components/sanita-leads.tsx"
install -m 644 /tmp/control-route.ts "$UI/src/app/api/sanita/archive-revalidation/control/route.ts"
install -m 644 /tmp/sanita-leads.tsx "$APP/src/components/sanita-leads.tsx"
install -m 644 /tmp/control-route.ts "$APP/src/app/api/sanita/archive-revalidation/control/route.ts"

# Rebuild Next UI (pm2)
cd "$UI"
export SCAN_ENGINE_LOCAL=1
export DATABASE_URL="file:$UI/prisma/dev.db"
npm run build 2>&1 | tail -40
pm2 restart leadsniper-ui --update-env
sleep 3
curl -s -o /dev/null -w "ui_http=%{http_code}\n" http://127.0.0.1:3000/sanita
curl -s 'http://127.0.0.1:3000/api/sanita?includeAll=1' | python3 -c "import sys,json;j=json.load(sys.stdin);print('live',len(j.get('data')or[]))"
curl -s 'http://127.0.0.1:3000/api/sanita/archive-revalidation/results?scope=run' | python3 -c "import sys,json;j=json.load(sys.stdin);print('run',len(j.get('results')or[]))"
echo "enabled=$(systemctl is-enabled giorgio-revalidate)"
echo "active=$(systemctl is-active giorgio-revalidate || true)"
grep APPLY_LIVE /etc/systemd/system/giorgio-revalidate.service.d/00-safety.conf
echo DEPLOY_UI_DONE
