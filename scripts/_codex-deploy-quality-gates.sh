#!/usr/bin/env bash
set -euo pipefail

app=/opt/leadsniper-revalidate/app
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="/opt/leadsniper-revalidate/backups/codex-quality-gates-${stamp}"
mkdir -p "$backup/scripts" "$backup/src/lib/sanita" "$backup/checkpoint"

for file in \
  scripts/production-revalidate-sanita-v3.mjs \
  scripts/production-revalidate-sanita-worker.mjs \
  scripts/revalidate-checkpoint-v3.mjs \
  src/lib/sanita/published-subtype.ts \
  src/lib/sanita/entity-fingerprint.ts \
  src/lib/sanita/scan-engine.ts \
  src/lib/sanita/site-identity.ts \
  src/lib/sanita/ocr.ts
do
  mkdir -p "$backup/$(dirname "$file")"
  cp "$app/$file" "$backup/$file"
done
cp /opt/leadsniper-revalidate/data/revalidation/checkpoint.json \
  "$backup/checkpoint/checkpoint.json"

install -m 0644 /tmp/codex-production-revalidate-sanita-v3.mjs \
  "$app/scripts/production-revalidate-sanita-v3.mjs"
install -m 0644 /tmp/codex-production-revalidate-sanita-worker.mjs \
  "$app/scripts/production-revalidate-sanita-worker.mjs"
install -m 0644 /tmp/codex-revalidate-checkpoint-v3.mjs \
  "$app/scripts/revalidate-checkpoint-v3.mjs"
install -m 0644 /tmp/codex-published-subtype.ts \
  "$app/src/lib/sanita/published-subtype.ts"
install -m 0644 /tmp/codex-entity-fingerprint.ts \
  "$app/src/lib/sanita/entity-fingerprint.ts"
install -m 0644 /tmp/codex-scan-engine.ts \
  "$app/src/lib/sanita/scan-engine.ts"
install -m 0644 /tmp/codex-site-identity.ts \
  "$app/src/lib/sanita/site-identity.ts"
install -m 0644 /tmp/codex-ocr.ts \
  "$app/src/lib/sanita/ocr.ts"

systemctl restart giorgio-revalidate
sleep 5
systemctl is-active giorgio-revalidate
systemctl show giorgio-revalidate \
  -p NRestarts \
  -p ActiveEnterTimestamp \
  -p MemoryCurrent \
  -p MemoryPeak \
  -p MemorySwapCurrent \
  -p MemorySwapPeak
echo "backup=$backup"
cd "$app"
sha256sum \
  scripts/production-revalidate-sanita-v3.mjs \
  scripts/production-revalidate-sanita-worker.mjs \
  scripts/revalidate-checkpoint-v3.mjs \
  src/lib/sanita/published-subtype.ts \
  src/lib/sanita/entity-fingerprint.ts \
  src/lib/sanita/scan-engine.ts \
  src/lib/sanita/site-identity.ts \
  src/lib/sanita/ocr.ts
