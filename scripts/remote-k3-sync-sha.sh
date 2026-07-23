#!/usr/bin/env bash
# Sync revalidate app to a specific SHA (surgical, no blue rebuild).
set -euo pipefail
SHA="${1:?sha}"
SRC=/opt/giorgio-src
APP=/opt/leadsniper-revalidate/app
UI=/opt/leadsniper

if [ ! -d "$SRC/.git" ]; then
  git clone https://github.com/pallii5811/GiorgioSoftware.git "$SRC"
fi
cd "$SRC"
git fetch origin
git checkout -f "$SHA"
git rev-parse HEAD

# Sync engine sources used by worker
rsync -a \
  "$SRC/src/lib/sanita/" "$APP/src/lib/sanita/"
rsync -a \
  "$SRC/src/components/sanita-leads.tsx" "$APP/src/components/sanita-leads.tsx"
rsync -a \
  "$SRC/src/app/api/sanita/route.ts" "$APP/src/app/api/sanita/route.ts"
rsync -a \
  "$SRC/scripts/k3-micro-canary10.mjs" \
  "$SRC/scripts/test-regression-corpus.mjs" \
  "$SRC/scripts/test-self-insurance.mjs" \
  "$SRC/scripts/production-revalidate-sanita-v3.mjs" \
  "$SRC/scripts/production-revalidate-sanita-worker.mjs" \
  "$APP/scripts/" 2>/dev/null || true
mkdir -p "$APP/tests/fixtures/sanita"
rsync -a "$SRC/tests/fixtures/sanita/regression-corpus/" "$APP/tests/fixtures/sanita/regression-corpus/"
echo "$SHA" > "$APP/RELEASE_SHA"

# Blue UI sources (build later)
rsync -a "$SRC/src/lib/sanita/" "$UI/src/lib/sanita/"
rsync -a "$SRC/src/components/sanita-leads.tsx" "$UI/src/components/sanita-leads.tsx"
rsync -a "$SRC/src/app/api/sanita/route.ts" "$UI/src/app/api/sanita/route.ts"

cd "$APP"
npx tsx scripts/test-regression-corpus.mjs
npx tsx scripts/test-self-insurance.mjs
echo "SYNCED=$(cat RELEASE_SHA)"
