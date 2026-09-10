#!/usr/bin/env bash
set -euo pipefail

app="/opt/leadsniper-revalidate/app"
data="/opt/leadsniper-revalidate/data/revalidation"
lead_id="cmqooitvu0062aa3vxoq0ebok"
frontier="$data/frontiers/reval-p1-cmqooitvu0062aa3vxoq0ebok-1785035062256.sqlite"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="/opt/leadsniper-revalidate/backups/non-document-binary-guard-$stamp"
files=(
  "src/lib/sanita/detector.ts"
  "src/lib/sanita/site-resource.ts"
  "src/lib/sanita/frontier-store.ts"
  "src/lib/sanita/crawl-slice-runner.ts"
  "scripts/test-exhaustive-site-coverage.mjs"
  "scripts/test-published-defense.mjs"
)

restore_and_start() {
  for file in "${files[@]}"; do
    if [[ -f "$backup/app/$file" ]]; then
      install -D -m 0644 "$backup/app/$file" "$app/$file"
    fi
  done
  systemctl start giorgio-revalidate || true
}
trap restore_and_start ERR

systemctl stop giorgio-revalidate
mkdir -p "$backup/app" "$backup/data"
for file in "${files[@]}"; do
  mkdir -p "$backup/app/$(dirname "$file")"
  cp "$app/$file" "$backup/app/$file"
  install -D -m 0644 "/tmp/codex-binary/$(basename "$file")" "$app/$file"
done
cp "$data/checkpoint.json" "$backup/data/checkpoint.json"
cp --reflink=auto --sparse=always "$frontier" "$backup/data/$(basename "$frontier")"
for suffix in -wal -shm; do
  if [[ -f "$frontier$suffix" ]]; then
    cp --reflink=auto --sparse=always "$frontier$suffix" \
      "$backup/data/$(basename "$frontier")$suffix"
  fi
done

cd "$app"
npx tsx scripts/test-exhaustive-site-coverage.mjs
npx tsx scripts/test-published-defense.mjs
TARGET_LEAD_ID="$lead_id" \
TARGET_REASON="NON_DOCUMENT_BINARY_CRASH_GUARD" \
  node scripts/_codex-prioritize-villa.mjs

trap - ERR
systemctl start giorgio-revalidate
systemctl is-active giorgio-revalidate
echo "BACKUP=$backup"
sha256sum "${files[@]/#/$app/}"
