#!/bin/bash
# Deploy K3 tip code WITHOUT touching DB / evidence / scan start
set -euo pipefail
SHA=58a0deedf42d4e2b106d12926ac559e27ed851e6
UI=/opt/leadsniper
APP=/opt/leadsniper-revalidate/app
STAGE=/tmp/k3-tip-extract
export PATH="/snap/bin:$PATH"
export DEBIAN_FRONTEND=noninteractive

echo "=== PRECHECK DB ==="
python3 - <<'PY'
import sqlite3, hashlib
from pathlib import Path
p=Path('/opt/leadsniper/prisma/dev.db')
h=hashlib.sha256(p.read_bytes()).hexdigest()
c=sqlite3.connect(f'file:{p.as_posix()}?mode=ro', uri=True)
hc=c.execute("select count(*) from Lead where type='HEALTHCARE'").fetchone()[0]
assert hc==877, hc
assert h=='cfb9e8781b2fb03c8989e3b79843cfbebb0742119c91e847e227a459909063ab', h
print('DB_OK', hc, h[:16])
PY

# stop UI briefly for swap; keep revalidate OFF
pm2 stop leadsniper-ui || true
systemctl stop giorgio-revalidate 2>/dev/null || true
systemctl disable giorgio-revalidate 2>/dev/null || true

# preserve DB + env + tessdata + .next will rebuild
mkdir -p /tmp/preserve-k3
cp -a "$UI/prisma/dev.db" /tmp/preserve-k3/dev.db
cp -a "$UI/.env" /tmp/preserve-k3/.env
cp -a "$UI/.tesseract-cache" /tmp/preserve-k3/tesseract-cache 2>/dev/null || true
cp -a /opt/leadsniper-revalidate/shadow-revalidate.db /tmp/preserve-k3/shadow.db 2>/dev/null || true
cp -a /opt/leadsniper-revalidate/data /tmp/preserve-k3/reval-data 2>/dev/null || true

rm -rf "$STAGE"
mkdir -p "$STAGE"
tar -xzf /tmp/k3-tip-deploy.tgz -C "$STAGE"

# sync code into UI excluding runtime state
rsync -a --delete \
  --exclude node_modules --exclude .next --exclude prisma/dev.db \
  --exclude .env --exclude .env.local --exclude .tesseract-cache \
  --exclude 'data/sanita-jobs' --exclude 'data/shadow' \
  "$STAGE/" "$UI/"

echo "$SHA" > "$UI/RELEASE_SHA"
install -m 0644 /tmp/preserve-k3/dev.db "$UI/prisma/dev.db"
install -m 600 /tmp/preserve-k3/.env "$UI/.env"
# ensure engine flags + chromium
grep -q SCAN_ENGINE_LOCAL "$UI/.env" || cat >> "$UI/.env" <<'EOF'
SCAN_ENGINE_LOCAL=1
OCR_ENABLED=1
POLICY_EXHAUSTIVE=1
SCAN_FAST=0
NODE_ENV=production
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/snap/bin/chromium
CHROMIUM_PATH=/snap/bin/chromium
EOF
# force IP constant already in tip archive (167.233...)
grep -n HETZNER_SCAN_ENGINE "$UI/src/lib/sanita/scan-engine-url.ts"

# restore tessdata
mkdir -p "$UI/.tesseract-cache"
if [[ -d /tmp/preserve-k3/tesseract-cache ]]; then
  cp -a /tmp/preserve-k3/tesseract-cache/. "$UI/.tesseract-cache/"
fi
if [[ ! -f "$UI/.tesseract-cache/ita.traineddata" ]]; then
  cd "$UI" && npx tsx scripts/download-tessdata.mjs || true
fi

cd "$UI"
# keep existing node_modules if present; refresh lockstep
if [[ ! -d node_modules ]]; then npm ci; else npm ci; fi
npx prisma generate
# do NOT db push in a way that wipes — schema sync only if needed
npx prisma db push --skip-generate || true

echo "=== POSTCHECK DB UNCHANGED ==="
python3 - <<'PY'
import sqlite3, hashlib
from pathlib import Path
p=Path('/opt/leadsniper/prisma/dev.db')
h=hashlib.sha256(p.read_bytes()).hexdigest()
c=sqlite3.connect(f'file:{p.as_posix()}?mode=ro', uri=True)
hc=c.execute("select count(*) from Lead where type='HEALTHCARE'").fetchone()[0]
assert hc==877 and h=='cfb9e8781b2fb03c8989e3b79843cfbebb0742119c91e847e227a459909063ab', (hc,h)
print('DB_STILL_OK', hc)
# reference leads
for name in ["Villa Dei Pini", "Malzoni"]:
  rows=c.execute("select companyName, substr(evidence,1,60) from Lead where companyName like ? limit 2", (f"%{name}%",)).fetchall()
  print(name, rows)
PY

npm run build

# revalidate app tree (code only)
mkdir -p "$APP" /opt/leadsniper-revalidate/logs \
  /opt/leadsniper-revalidate/data/revalidation/frontiers \
  /opt/leadsniper-revalidate/data/revalidation/results \
  /opt/leadsniper-revalidate/data/revalidation/locks
rsync -a --delete \
  --exclude node_modules --exclude .next --exclude prisma/dev.db \
  --exclude .env --exclude .tesseract-cache \
  --exclude 'data/sanita-jobs' --exclude 'data/shadow' \
  "$UI/" "$APP/"
rm -rf "$APP/node_modules" "$APP/.next"
ln -sfn "$UI/node_modules" "$APP/node_modules"
ln -sfn "$UI/.next" "$APP/.next"
echo "$SHA" > "$APP/RELEASE_SHA"
install -m 0644 /tmp/preserve-k3/shadow.db /opt/leadsniper-revalidate/shadow-revalidate.db
# restore reval data dirs (empty checkpoint ok) without wiping if we preserved
if [[ -d /tmp/preserve-k3/reval-data ]]; then
  rsync -a /tmp/preserve-k3/reval-data/ /opt/leadsniper-revalidate/data/
fi
mkdir -p "$APP/.tesseract-cache"
cp -a "$UI/.tesseract-cache/." "$APP/.tesseract-cache/" || true

# systemd — keep disabled, MemoryMax for 4GB box
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
systemctl stop giorgio-revalidate || true

# start UI only
pm2 delete leadsniper-ui 2>/dev/null || true
cd "$UI"
PORT=3000 SCAN_ENGINE_LOCAL=1 OCR_ENABLED=1 POLICY_EXHAUSTIVE=1 \
  DATABASE_URL='file:/opt/leadsniper/prisma/dev.db' \
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/snap/bin/chromium \
  pm2 start npm --name leadsniper-ui --update-env -- start -- -H 0.0.0.0 -p 3000
pm2 save

sleep 4
curl -s -o /tmp/api.json -w "HTTP:%{http_code}\n" "http://127.0.0.1:3000/api/sanita?includeAll=1&includePending=1"
python3 - <<'PY'
import json
from pathlib import Path
j=json.loads(Path('/tmp/api.json').read_text())
d=j.get('data') or []
m=j.get('meta') or {}
print({'api':len(d),'dbTotal':m.get('dbTotal'),'release':open('/opt/leadsniper/RELEASE_SHA').read().strip()})
assert len(d)==877 or m.get('dbTotal')==877
print('API_OK')
PY
echo "DEPLOY_OK SHA=$SHA SCAN=OFF"
