#!/bin/bash
set -euo pipefail

UI=/opt/leadsniper
RV=/opt/leadsniper-revalidate
APP=$RV/app

echo ">>> Extract code into UI"
mkdir -p "$UI"
tar -xzf /tmp/leadsniper-code.tgz -C "$UI"
cd "$UI"
echo e96994fc165f289c177837df112186a875f57a6e > "$UI/RELEASE_SHA"

echo ">>> Restore live DB from immutable backup COPY (do not overwrite source on laptop)"
mkdir -p "$UI/prisma"
install -m 0644 /tmp/giorgio-live-restore.db "$UI/prisma/dev.db"
python3 - <<'PY'
import sqlite3, hashlib
from pathlib import Path
p=Path("/opt/leadsniper/prisma/dev.db")
h=hashlib.sha256(p.read_bytes()).hexdigest()
c=sqlite3.connect(f"file:{p.as_posix()}?mode=ro", uri=True)
n=c.execute("select count(*) from Lead").fetchone()[0]
hc=c.execute("select count(*) from Lead where type='HEALTHCARE'").fetchone()[0]
print({"sha256":h,"leads":n,"healthcare":hc})
assert h=="cfb9e8781b2fb03c8989e3b79843cfbebb0742119c91e847e227a459909063ab"
assert n==1237 and hc==877
print("DB_RESTORE_OK")
PY

echo ">>> Env"
if [[ ! -f "$UI/.env" ]]; then
  echo 'DATABASE_URL="file:./dev.db"' > "$UI/.env"
fi
# append scan flags if missing
grep -q SCAN_ENGINE_LOCAL "$UI/.env" || cat >> "$UI/.env" <<'EOF'
SCAN_ENGINE_LOCAL=1
OCR_ENABLED=1
POLICY_EXHAUSTIVE=1
SCAN_FAST=0
NODE_ENV=production
EOF

echo ">>> npm ci + playwright + tessdata"
npm ci
npx playwright install chromium
npx tsx scripts/download-tessdata.mjs || true
npx prisma generate

echo ">>> Build UI"
npm run build

echo ">>> pm2 UI"
npm install -g pm2
pm2 delete leadsniper-ui 2>/dev/null || true
PORT=3000 SCAN_ENGINE_LOCAL=1 OCR_ENABLED=1 POLICY_EXHAUSTIVE=1 DATABASE_URL='file:/opt/leadsniper/prisma/dev.db' \
  pm2 start npm --name leadsniper-ui --update-env -- start -- -H 0.0.0.0 -p 3000
pm2 save
pm2 startup systemd -u root --hp /root | tail -n 1 | bash || true

echo ">>> Revalidate tree (shadow DB = copy of restore; APPLY_LIVE stays off)"
mkdir -p "$APP" "$RV/data/revalidation/frontiers" "$RV/data/revalidation/results" "$RV/data/revalidation/locks" "$RV/logs" "$RV/data/k3-stopship"
# app code = same tree (rsync exclude heavy)
rsync -a --delete \
  --exclude=.next --exclude=node_modules --exclude=prisma/dev.db \
  --exclude=data/shadow --exclude=data/playwright --exclude=data/sanita-jobs \
  "$UI/" "$APP/"
# link node_modules and .next from UI to save disk/RAM duplication for now
rm -rf "$APP/node_modules" "$APP/.next"
ln -s "$UI/node_modules" "$APP/node_modules"
ln -s "$UI/.next" "$APP/.next"
cp "$UI/RELEASE_SHA" "$APP/RELEASE_SHA"
install -m 0644 /tmp/giorgio-live-restore.db "$RV/shadow-revalidate.db"
# empty checkpoint v3
python3 - <<'PY'
import json
from pathlib import Path
from datetime import datetime, timezone
cp={
  "version":3,
  "testedCodeSha": open("/opt/leadsniper-revalidate/app/RELEASE_SHA").read().strip(),
  "terminal":{},
  "retryQueue":{},
  "inProgress":{},
  "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00","Z"),
}
Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").write_text(json.dumps(cp,indent=2),encoding="utf-8")
print("CHECKPOINT_INIT", cp["testedCodeSha"])
PY
# tessdata for revalidate
mkdir -p "$APP/.tesseract-cache"
if [[ -d "$UI/.tesseract-cache" ]]; then
  cp -a "$UI/.tesseract-cache/." "$APP/.tesseract-cache/" || true
fi

# systemd unit sized for 4GB RAM
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
Environment=CRAWL_HTML_URL_CAP=40
Environment=CRAWL_RUN_MAX_WALL_CLOCK_MS=1800000
Environment=CRAWL_MAX_HTML_PER_SLICE=12
Environment=PER_HOST_CONCURRENCY=1
Environment=REVALIDATE_LEAD_WALL_MS=1800000
Environment=NODE_OPTIONS=--max-old-space-size=1536
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
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
# DO NOT start revalidate yet — only UI. User can start when ready.
systemctl disable giorgio-revalidate || true

sleep 3
curl -s -o /tmp/health.json -w "HTTP:%{http_code}\n" "http://127.0.0.1:3000/api/sanita?region=Campania&includePending=1" || true
python3 - <<'PY'
import json
from pathlib import Path
p=Path('/tmp/health.json')
if not p.exists() or p.stat().st_size==0:
  print('UI_API_EMPTY'); raise SystemExit(1)
j=json.loads(p.read_text())
leads=j.get('leads') or j
if isinstance(leads, dict):
  leads=leads.get('data') or []
print({'apiLeads': len(leads), 'sample': (leads[0].get('companyName') if leads else None)})
PY

echo "BOOTSTRAP_OK"
