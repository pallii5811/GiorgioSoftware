#!/bin/bash
set -e
cd /opt/leadsniper
D=/tmp/leadsniper-deploy
for f in gelli-scope.ts playwright-maps.ts; do
  [ -f "$D/$f" ] && mv "$D/$f" "src/lib/sanita/$f"
done
for f in delivery-certification.mjs fix-delivery-blockers.mjs count-non-gelli-targets.mjs; do
  [ -f "$D/$f" ] && mv "$D/$f" "scripts/$f"
done
echo "=== FIX SCOPE ==="
npx tsx scripts/fix-delivery-blockers.mjs
echo "=== OFF SCOPE COUNT ==="
npx tsx scripts/count-non-gelli-targets.mjs
echo "=== CERTIFY ==="
npx tsx scripts/delivery-certification.mjs || true
