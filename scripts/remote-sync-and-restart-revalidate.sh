#!/usr/bin/env bash
set -uo pipefail
# Sync green+revalidate from GitHub SHA, ensure tessdata, single-flight restart.
# Usage: bash remote-sync-and-restart-revalidate.sh [sha]

SHA="${1:-eb2988a335e01c2723167f1ba79fe85da244f981}"
APP_BLUE=/opt/leadsniper
APP_GREEN=/opt/leadsniper-green
WORKDIR=/opt/leadsniper-revalidate

pkill -f 'production-revalidate-sanita-v2' 2>/dev/null || true
sleep 2
pkill -9 -f 'production-revalidate-sanita-v2' 2>/dev/null || true
rm -f "$WORKDIR/revalidate.pid"
pgrep -af 'production-revalidate' || echo "cleared"

if [ ! -d /opt/giorgio-src/.git ]; then
  git clone https://github.com/pallii5811/GiorgioSoftware.git /opt/giorgio-src
fi
cd /opt/giorgio-src
git fetch origin
git checkout -f "$SHA"
git rev-parse HEAD > /tmp/release.sha
ACTUAL=$(cat /tmp/release.sha)
echo "SYNC_SHA=$ACTUAL"

rsync -a --delete \
  --exclude=.env --exclude=.env.* --exclude=node_modules --exclude=.next \
  --exclude='*.db' --exclude='*.db-*' --exclude=data/revalidation \
  --exclude=.tesseract-cache --exclude=backups --exclude=shadow \
  /opt/giorgio-src/ "$APP_GREEN/"

echo "$ACTUAL" > "$APP_GREEN/RELEASE_SHA"
if [ -f "$APP_BLUE/.env" ]; then cp -a "$APP_BLUE/.env" "$APP_GREEN/.env"; fi

cd "$APP_GREEN"
npm ci
node scripts/prisma-smart.mjs

mkdir -p "$APP_GREEN/.tesseract-cache"
if [ ! -f "$APP_GREEN/.tesseract-cache/ita.traineddata" ]; then
  for src in \
    "$APP_BLUE/.tesseract-cache" \
    /opt/leadsniper.bak./.tesseract-cache \
    /usr/share/tesseract-ocr/5/tessdata \
    /usr/share/tesseract-ocr/4.00/tessdata \
    /usr/share/tessdata; do
    if [ -f "$src/ita.traineddata" ]; then
      cp -a "$src"/*.traineddata "$APP_GREEN/.tesseract-cache/" 2>/dev/null || true
      # tesseract.js may look for special-words sidecar files; copy all
      cp -a "$src"/* "$APP_GREEN/.tesseract-cache/" 2>/dev/null || true
      break
    fi
  done
fi
if [ ! -f "$APP_GREEN/.tesseract-cache/ita.traineddata" ]; then
  curl -fsSL -o "$APP_GREEN/.tesseract-cache/ita.traineddata" \
    https://github.com/tesseract-ocr/tessdata/raw/main/ita.traineddata
  curl -fsSL -o "$APP_GREEN/.tesseract-cache/eng.traineddata" \
    https://github.com/tesseract-ocr/tessdata/raw/main/eng.traineddata
fi
ls "$APP_GREEN/.tesseract-cache" | head -20

mkdir -p "$WORKDIR/app" "$WORKDIR/data/revalidation/results" "$WORKDIR/data/revalidation/frontiers" "$WORKDIR/logs"
rsync -a --delete \
  --exclude=.env --exclude=node_modules --exclude=.next \
  --exclude=data/revalidation --exclude='*.db' --exclude='*.db-*' \
  --exclude=.tesseract-cache \
  "$APP_GREEN/" "$WORKDIR/app/"
rsync -a "$APP_GREEN/node_modules/" "$WORKDIR/app/node_modules/"
mkdir -p "$WORKDIR/app/.tesseract-cache"
rsync -a "$APP_GREEN/.tesseract-cache/" "$WORKDIR/app/.tesseract-cache/"
echo "$ACTUAL" > "$WORKDIR/app/RELEASE_SHA"
if [ -f "$APP_BLUE/.env" ]; then cp -a "$APP_BLUE/.env" "$WORKDIR/app/.env"; fi

if [ ! -f "$WORKDIR/shadow-revalidate.db" ]; then
  SHADOW=$(ls -1t /opt/leadsniper/shadow/giorgio-shadow-*.db | head -1)
  cp -a "$SHADOW" "$WORKDIR/shadow-revalidate.db"
fi

python3 - <<PY
import json, pathlib, datetime
p=pathlib.Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
sha=open("/opt/leadsniper-green/RELEASE_SHA").read().strip()
if p.exists():
  cp=json.load(p.open())
else:
  cp={"version":2,"startedAt":datetime.datetime.utcnow().isoformat()+"Z","done":{},"order":[],"stats":{"processed":0,"hot":0,"pub":0,"review":0,"retry":0,"tech":0,"errors":0}}
cp["testedCodeSha"]=sha
cp["updatedAt"]=datetime.datetime.utcnow().isoformat()+"Z"
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps(cp, indent=2))
print("checkpoint_done", len(cp.get("done") or {}), "sha", sha)
PY

mkdir -p "$WORKDIR/app/data/revalidation"
ln -sfn "$WORKDIR/data/revalidation/results" "$WORKDIR/app/data/revalidation/results"
ln -sfn "$WORKDIR/data/revalidation/frontiers" "$WORKDIR/app/data/revalidation/frontiers"

# Single-flight: refuse if another started between kill and now
if pgrep -f 'production-revalidate-sanita-v2' >/dev/null; then
  echo "STILL_RUNNING"; exit 2
fi

cd "$WORKDIR/app"
export GIT_HEAD="$ACTUAL"
export RELEASE_SHA="$ACTUAL"
export DATABASE_URL="file:$WORKDIR/shadow-revalidate.db"
export SCAN_ENGINE_LOCAL=1
export OCR_ENABLED=1
export POLICY_EXHAUSTIVE=1
export SCAN_FAST=0
export STAGING_MODE=true
export DISABLE_LIVE_DB=true
export DISABLE_EMAILS=true
export REVALIDATE_CONCURRENCY=2
export REVALIDATE_DUAL_HOT=1
export REVALIDATE_CHECKPOINT="$WORKDIR/data/revalidation/checkpoint.json"
export TESSDATA_PREFIX="$WORKDIR/app/.tesseract-cache"
export PDFTOPPM_PATH="$(command -v pdftoppm || true)"
export FRONTIER_DB_PATH="$WORKDIR/data/revalidation/frontiers/boot.sqlite"

LOG="$WORKDIR/logs/revalidate-$(date -u +%Y%m%dT%H%M%SZ).log"
nohup npx tsx scripts/production-revalidate-sanita-v2.mjs >>"$LOG" 2>&1 &
echo $! > "$WORKDIR/revalidate.pid"
sleep 10
echo "STARTED pid=$(cat $WORKDIR/revalidate.pid) log=$LOG sha=$ACTUAL"
head -n 12 "$LOG" || true
pgrep -c -f 'production-revalidate-sanita-v2' || true
