#!/bin/bash
set -e
cd /opt/leadsniper
D=/tmp/leadsniper-deploy
mv "$D/policy-verify.ts" src/lib/sanita/
mv "$D/playwright-maps.ts" src/lib/sanita/
mv "$D/delivery-certification.mjs" scripts/
mv "$D/fix-delivery-blockers.mjs" scripts/
mv "$D/quality-gate.mjs" scripts/
mv "$D/gare-certification.mjs" scripts/
mv "$D/server-stats.mjs" scripts/
mkdir -p src/lib/gare
mv "$D/relevance.ts" src/lib/gare/
cp /tmp/leadsniper-deploy/gelli-scope.ts src/lib/sanita/ 2>/dev/null || true
echo "=== BEFORE ==="
npx tsx scripts/server-stats.mjs
echo "=== FIX BLOCKERS ==="
npx tsx scripts/fix-delivery-blockers.mjs
echo "=== AFTER FIX ==="
npx tsx scripts/server-stats.mjs
echo "=== CERTIFY ==="
npx tsx scripts/delivery-certification.mjs || true
