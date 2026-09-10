#!/usr/bin/env bash
set -euo pipefail

app=/opt/leadsniper-revalidate/app
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="/opt/leadsniper-revalidate/backups/codex-published-date-${stamp}"
mkdir -p "$backup/src/lib/sanita" "$backup/scripts"

cp "$app/src/lib/sanita/published-subtype.ts" \
  "$backup/src/lib/sanita/published-subtype.ts"
cp "$app/scripts/revalidate-checkpoint-v3.mjs" \
  "$backup/scripts/revalidate-checkpoint-v3.mjs"

install -m 0644 /tmp/codex-published-subtype.ts \
  "$app/src/lib/sanita/published-subtype.ts"
install -m 0644 /tmp/codex-revalidate-checkpoint-v3.mjs \
  "$app/scripts/revalidate-checkpoint-v3.mjs"

systemctl restart giorgio-revalidate
sleep 3
systemctl is-active giorgio-revalidate
systemctl show giorgio-revalidate \
  -p NRestarts \
  -p ActiveEnterTimestamp \
  -p MemoryCurrent \
  -p MemoryPeak \
  -p MemorySwapCurrent \
  -p MemorySwapPeak
echo "backup=$backup"
sha256sum \
  "$app/src/lib/sanita/published-subtype.ts" \
  "$app/scripts/revalidate-checkpoint-v3.mjs"
