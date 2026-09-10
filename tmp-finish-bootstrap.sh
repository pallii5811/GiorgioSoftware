#!/bin/bash
set -euo pipefail
UI=/opt/leadsniper
RV=/opt/leadsniper-revalidate
APP=$RV/app
export PATH="/snap/bin:$PATH"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# system chromium (Ubuntu 26.04 — playwright browsers unsupported)
export CHROMIUM_PATH=/snap/bin/chromium
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/snap/bin/chromium

cd "$UI"

# ensure DB still intact after any prisma push
python3 - <<'PY'
import sqlite3, hashlib
from pathlib import Path
p=Path("/opt/leadsniper/prisma/dev.db")
h=hashlib.sha256(p.read_bytes()).hexdigest()
c=sqlite3.connect(f"file:{p.as_posix()}?mode=ro", uri=True)
n=c.execute("select count(*) from Lead").fetchone()[0]
hc=c.execute("select count(*) from Lead where type='HEALTHCARE'").fetchone()[0]
print({"sha256":h,"leads":n,"healthcare":hc})
assert n==1237 and hc==877, (n,hc)
print("DB_STILL_OK")
PY

# append chromium env to .env if missing
grep -q PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH "$UI/.env" || cat >> "$UI/.env" <<'EOF'
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/snap/bin/chromium
CHROMIUM_PATH=/snap/bin/chromium
SCAN_ENGINE_LOCAL=1
OCR_ENABLED=1
POLICY_EXHAUSTIVE=1
SCAN_FAST=0
NODE_ENV=production
DATABASE_URL="file:./dev.db"
EOF

echo ">>> tessdata"
npx tsx scripts/download-tessdata.mjs || true
npx prisma generate

echo ">>> build"
npm run build

echo ">>> pm2"
npm install -g pm2
pm2 delete leadsniper-ui 2>/dev/null || true
pm2 start npm --name leadsniper-ui --update-env -- start -- -H 0.0.0.0 -p 3000
pm2 save
(pm2 startup systemd -u root --hp /root | tail -n 1 | bash) || true

echo ">>> revalidate tree"
mkdir -p "$APP" "$RV/data/revalidation/frontiers" "$RV/data/revalidation/results" "$RV/data/revalidation/locks" "$RV/logs" "$RV/data/k3-stopship"
rsync -a --delete \
  --exclude=.next --exclude=node_modules --exclude=prisma/dev.db \
  --exclude=data/shadow --exclude='data/playwright*' --exclude=data/sanita-jobs \
  "$UI/" "$APP/"
rm -rf "$APP/node_modules" "$APP/.next"
ln -sfn "$UI/node_modules" "$APP/node_modules"
ln -sfn "$UI/.next" "$APP/.next"
cp -f "$UI/RELEASE_SHA" "$APP/RELEASE_SHA"
install -m 0644 /tmp/giorgio-live-restore.db "$RV/shadow-revalidate.db"
mkdir -p "$APP/.tesseract-cache"
[[ -d "$UI/.tesseract-cache" ]] && cp -a "$UI/.tesseract-cache/." "$APP/.tesseract-cache/" || true

python3 - <<'PY'
import json
from pathlib import Path
from datetime import datetime, timezone
sha=Path("/opt/leadsniper-revalidate/app/RELEASE_SHA").read_text().strip()
cp={
  "version":3,
  "testedCodeSha": sha,
  "terminal":{},
  "retryQueue":{},
  "inProgress":{},
  "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00","Z"),
}
Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").write_text(json.dumps(cp,indent=2),encoding="utf-8")
print("CHECKPOINT_INIT", sha)
PY

cat >/etc/systemd/system/giorgio-revalidate.service <<'UNIT'
[Unit]
Description=Giorgio Sanita shadow revalidation v3 (single parent via flock)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/leadsniper-revalidate/app
Environment=DATABASE_URL=file:/opt/leadsniper-revalidate/shadow-revalidate.db
Environment=SCAN_ENGINE_LOCAL=1
Environment=OCR_ENABLED=1
Environment=POLICY_EXHAUSTIVE=1
Environment=SCAN_FAST=0
Environment=STAGING_MODE=true
Environment=DISABLE_LIVE_DB=true
Environment=DISABLE_EMAILS=true
Environment=TOTAL_WORKERS=1
Environment=REVALIDATE_CONCURRENCY=1
Environment=REVALIDATE_DUAL_HOT=1
Environment=REVALIDATE_CHECKPOINT=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json
Environment=REVALIDATE_OUT_DIR=/opt/leadsniper-revalidate/data/revalidation
Environment=TESSDATA_PREFIX=/opt/leadsniper-revalidate/app/.tesseract-cache
Environment=FRONTIER_DB_PATH=/opt/leadsniper-revalidate/data/revalidation/frontiers/boot.sqlite
Environment=PDFTOPPM_PATH=/usr/bin/pdftoppm
Environment=PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/snap/bin/chromium
Environment=CHROMIUM_PATH=/snap/bin/chromium
Environment=PATH=/snap/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=CRAWL_HTML_URL_CAP=40
Environment=CRAWL_RUN_MAX_WALL_CLOCK_MS=1800000
Environment=CRAWL_MAX_HTML_PER_SLICE=12
Environment=PER_HOST_CONCURRENCY=1
Environment=REVALIDATE_LEAD_WALL_MS=1800000
Environment=NODE_OPTIONS=--max-old-space-size=1536
TimeoutStopSec=1200
KillMode=mixed
KillSignal=SIGTERM
ExecStart=/usr/bin/flock -n /opt/leadsniper-revalidate/revalidate.parent.lock /bin/bash -c 'export GIT_HEAD=$(cat RELEASE_SHA); export RELEASE_SHA=$GIT_HEAD; exec npx tsx scripts/production-revalidate-sanita-v3.mjs'
Restart=on-failure
RestartSec=60
StandardOutput=append:/opt/leadsniper-revalidate/logs/systemd-revalidate.log
StandardError=append:/opt/leadsniper-revalidate/logs/systemd-revalidate.log
Nice=5
MemoryMax=2.5G

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl disable giorgio-revalidate || true

sleep 4
curl -s -o /tmp/health.json -w "HTTP:%{http_code}\n" "http://127.0.0.1:3000/api/sanita?region=Campania&includePending=1" || true
python3 - <<'PY'
import json
from pathlib import Path
raw=Path('/tmp/health.json').read_text(encoding='utf-8')
j=json.loads(raw)
leads=j.get('leads') if isinstance(j, dict) else j
if isinstance(leads, dict):
  leads=leads.get('data') or []
print({'httpLeads': len(leads)})
assert len(leads) >= 400, len(leads)
print('API_OK')
PY
echo "BOOTSTRAP_OK http://167.233.209.13:3000"
