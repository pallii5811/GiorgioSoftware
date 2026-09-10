#!/usr/bin/env bash
# Deploy OCR fix to revalidate app. Does NOT start 877 / corpus.
set -euo pipefail
STAGING=/tmp/stopship-ocr-fix
APP=/opt/leadsniper-revalidate/app
WORKER="$APP/scripts/production-revalidate-sanita-worker.mjs"
EXPECTED=f8843a46bfb1b3734116306216ee3d3bf52171fb2a45fb27f3331c9175acf071

test -f "$STAGING/src/lib/sanita/ocr.ts"
test -f "$STAGING/src/lib/sanita/frontier-store.ts"
test -f "$STAGING/src/lib/sanita/crawl-slice-runner.ts"
test -f "$STAGING/scripts/production-revalidate-sanita-v3.mjs"
test -f "$STAGING/scripts/preflight-ocr.mjs"

sha256sum "$WORKER" | tee /tmp/stopship-ocr-diag/worker-before.sha
grep -q "$EXPECTED" /tmp/stopship-ocr-diag/worker-before.sha

TS=$(date -u +%Y%m%dT%H%M%SZ)
BK=/opt/leadsniper-revalidate/backups/ocr-fix-$TS
mkdir -p "$BK/src/lib/sanita" "$BK/scripts" /etc/systemd/system/giorgio-revalidate.service.d
cp -a "$APP/src/lib/sanita/ocr.ts" "$BK/src/lib/sanita/" || true
cp -a "$APP/src/lib/sanita/frontier-store.ts" "$BK/src/lib/sanita/" || true
cp -a "$APP/src/lib/sanita/crawl-slice-runner.ts" "$BK/src/lib/sanita/" || true
cp -a "$APP/scripts/production-revalidate-sanita-v3.mjs" "$BK/scripts/" || true
cp -a "$APP/scripts/preflight-ocr.mjs" "$BK/scripts/" 2>/dev/null || true

install -m 0644 "$STAGING/src/lib/sanita/ocr.ts" "$APP/src/lib/sanita/ocr.ts"
install -m 0644 "$STAGING/src/lib/sanita/frontier-store.ts" "$APP/src/lib/sanita/frontier-store.ts"
install -m 0644 "$STAGING/src/lib/sanita/crawl-slice-runner.ts" "$APP/src/lib/sanita/crawl-slice-runner.ts"
install -m 0644 "$STAGING/scripts/production-revalidate-sanita-v3.mjs" "$APP/scripts/production-revalidate-sanita-v3.mjs"
install -m 0644 "$STAGING/scripts/preflight-ocr.mjs" "$APP/scripts/preflight-ocr.mjs"
install -m 0644 "$STAGING/scripts/test-ocr-pdftoppm-resolver.mjs" "$APP/scripts/test-ocr-pdftoppm-resolver.mjs"
install -m 0644 "$STAGING/scripts/test-ocr-contract.mjs" "$APP/scripts/test-ocr-contract.mjs" 2>/dev/null || true
install -m 0644 "$STAGING/scripts/systemd/giorgio-revalidate-ocr.conf" /etc/systemd/system/giorgio-revalidate.service.d/ocr.conf

systemctl daemon-reload
# Do NOT start the service — only refresh unit files
systemctl show giorgio-revalidate -p Environment --no-pager | tee /tmp/stopship-ocr-diag/env-after-dropin.txt

sha256sum "$WORKER" | tee /tmp/stopship-ocr-diag/worker-after.sha
diff -u /tmp/stopship-ocr-diag/worker-before.sha /tmp/stopship-ocr-diag/worker-after.sha

cd "$APP"
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PDFTOPPM_PATH=/usr/bin/pdftoppm
export TESSDATA_PREFIX=/opt/leadsniper-revalidate/app/.tesseract-cache
export OCR_ENABLED=1
npm run preflight:ocr | tee /tmp/stopship-ocr-diag/preflight.log
npx tsx scripts/test-ocr-pdftoppm-resolver.mjs | tee /tmp/stopship-ocr-diag/resolver-tests.log
npx tsx scripts/test-ocr-contract.mjs | tee /tmp/stopship-ocr-diag/contract-tests.log

echo OCR_FIX_DEPLOY_OK
