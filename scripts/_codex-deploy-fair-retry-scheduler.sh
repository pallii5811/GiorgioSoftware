#!/usr/bin/env bash
set -euo pipefail

app="/opt/leadsniper-revalidate/app"
data="/opt/leadsniper-revalidate/data/revalidation"
staging="/tmp/codex-fair-retry-scheduler"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="/opt/leadsniper-revalidate/backups/fair-retry-scheduler-$stamp"
files=(
  "scripts/revalidate-checkpoint-v3.mjs"
  "scripts/test-revalidation-v3.mjs"
)

rollback() {
  systemctl stop giorgio-revalidate 2>/dev/null || true
  for file in "${files[@]}"; do
    if [[ -f "$backup/app/$file" ]]; then
      install -D -m 0644 "$backup/app/$file" "$app/$file"
    fi
  done
  if [[ -f "$backup/RELEASE_SHA" ]]; then
    install -m 0644 "$backup/RELEASE_SHA" "$app/RELEASE_SHA"
  fi
  if [[ -f "$backup/data/checkpoint.json" ]]; then
    install -m 0644 "$backup/data/checkpoint.json" "$data/checkpoint.json"
  fi
  systemctl start giorgio-revalidate || true
}
trap rollback ERR

for file in "${files[@]}"; do
  test -f "$staging/$(basename "$file")"
done

mkdir -p "$backup/app" "$backup/data"
systemctl stop giorgio-revalidate
cp "$data/checkpoint.json" "$backup/data/checkpoint.json"
cp "$app/RELEASE_SHA" "$backup/RELEASE_SHA"
for file in "${files[@]}"; do
  mkdir -p "$backup/app/$(dirname "$file")"
  cp "$app/$file" "$backup/app/$file"
  install -D -m 0644 "$staging/$(basename "$file")" "$app/$file"
done

cd "$app"
npx tsx scripts/test-revalidation-v3.mjs
npx tsx scripts/test-published-defense.mjs
npx tsx scripts/test-hot-proof.mjs

previous_release="$(cat "$backup/RELEASE_SHA")"
scheduler_hash="$(sha256sum scripts/revalidate-checkpoint-v3.mjs | cut -d' ' -f1)"
release_fingerprint="$(
  printf '%s\n%s\n' "$previous_release" "$scheduler_hash" |
    sha1sum |
    cut -c1-40
)"
printf '%s\n' "$release_fingerprint" >"$app/RELEASE_SHA"

trap - ERR
systemctl start giorgio-revalidate
sleep 5
systemctl is-active --quiet giorgio-revalidate
systemctl show giorgio-revalidate -p MainPID -p NRestarts --no-pager
echo "RELEASE_SHA=$release_fingerprint"
echo "BACKUP=$backup"
