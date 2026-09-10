#!/usr/bin/env bash
set -euo pipefail

app="/opt/leadsniper-revalidate/app"
data="/opt/leadsniper-revalidate/data/revalidation"
lead_id="cmqn0oc270002zfo7py1ycxpo"
frontier="$data/frontiers/reval-p1-cmqn0oc270002zfo7py1ycxpo-1785013499280.sqlite"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="/opt/leadsniper-revalidate/backups/villa-cinzia-v12-$stamp"
files=(
  "src/lib/sanita/detector.ts"
  "src/lib/sanita/frontier-store.ts"
  "src/lib/sanita/crawl-slice-runner.ts"
  "src/lib/sanita/crawler.ts"
  "src/lib/sanita/lead-crawl-runtime.ts"
  "src/lib/sanita/audit.ts"
  "src/lib/sanita/scan-engine.ts"
  "src/lib/sanita/published-subtype.ts"
  "scripts/test-exhaustive-site-coverage.mjs"
  "scripts/test-frontier-evidence.mjs"
  "scripts/test-self-insurance.mjs"
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
done
cp "$data/checkpoint.json" "$backup/data/checkpoint.json"
cp "$data/results/$lead_id.json" "$backup/data/$lead_id.json"
cp --reflink=auto --sparse=always "$frontier" "$backup/data/$(basename "$frontier")"
for suffix in -wal -shm; do
  if [[ -f "$frontier$suffix" ]]; then
    cp --reflink=auto --sparse=always "$frontier$suffix" \
      "$backup/data/$(basename "$frontier")$suffix"
  fi
done

for file in "${files[@]}"; do
  install -D -m 0644 "/tmp/codex-v12/$(basename "$file")" "$app/$file"
done

cd "$app"
npx tsx scripts/test-exhaustive-site-coverage.mjs
npx tsx scripts/test-frontier-evidence.mjs
npx tsx scripts/test-self-insurance.mjs
npx tsx scripts/test-published-defense.mjs

if LEAD_ID="$lead_id" CHECKPOINT="$data/checkpoint.json" node -e '
  const fs = require("node:fs");
  const checkpoint = JSON.parse(fs.readFileSync(process.env.CHECKPOINT, "utf8"));
  process.exit(checkpoint.terminal?.[process.env.LEAD_ID] ? 0 : 1);
'; then
  TARGET_REASON="VILLA_CINZIA_POLICY_SOURCE_AND_EXPIRY_V12" \
    node scripts/_codex-requeue-terminal.mjs "$lead_id"
fi
TARGET_LEAD_ID="$lead_id" \
TARGET_REASON="VILLA_CINZIA_POLICY_SOURCE_AND_EXPIRY_V12" \
  node scripts/_codex-prioritize-villa.mjs

trap - ERR
systemctl start giorgio-revalidate
systemctl is-active giorgio-revalidate
echo "BACKUP=$backup"
sha256sum "${files[@]/#/$app/}"
