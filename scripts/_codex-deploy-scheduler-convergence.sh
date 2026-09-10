#!/usr/bin/env bash
set -euo pipefail

app="/opt/leadsniper-revalidate/app"
data="/opt/leadsniper-revalidate/data/revalidation"
staging="/tmp/codex-scheduler-convergence"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="/opt/leadsniper-revalidate/backups/scheduler-convergence-$stamp"
files=(
  "scripts/revalidate-checkpoint-v3.mjs"
  "scripts/production-revalidate-sanita-v3.mjs"
  "scripts/_frontier_inspect.py"
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
chmod 0755 "$app/scripts/_frontier_inspect.py"

cd "$app"
npx tsx scripts/test-revalidation-v3.mjs
npx tsx scripts/test-frontier-evidence.mjs
npx tsx scripts/test-published-defense.mjs
npx tsx scripts/test-hot-proof.mjs
npx tsx scripts/test-exhaustive-site-coverage.mjs
npx tsx scripts/test-stopship-no-tech-terminal.mjs

release_fingerprint="$(
  sha256sum \
    src/lib/sanita/crawl-slice-runner.ts \
    src/lib/sanita/lead-crawl-runtime.ts \
    src/lib/sanita/frontier-store.ts \
    src/lib/sanita/site-resource.ts \
    src/lib/sanita/ocr.ts \
    src/lib/sanita/detector.ts \
    scripts/revalidate-checkpoint-v3.mjs \
    scripts/production-revalidate-sanita-v3.mjs |
    sha256sum |
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
