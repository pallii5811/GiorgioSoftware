#!/usr/bin/env bash
set -euo pipefail

app="/opt/leadsniper"
stage="/tmp/codex-published-terminal-subtype"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="/opt/leadsniper/backups/published-terminal-subtype-$stamp"
files=(
  "src/lib/sanita/terminal-processing.ts"
  "scripts/test-published-terminal-subtype.mjs"
)

rollback() {
  for file in "${files[@]}"; do
    if [[ -f "$backup/$file" ]]; then
      install -D -m 0644 "$backup/$file" "$app/$file"
    elif [[ -f "$backup/.absent/${file//\//__}" ]]; then
      rm -f "$app/$file"
    fi
  done
}
trap rollback ERR

mkdir -p "$backup/.absent"
for file in "${files[@]}"; do
  if [[ -f "$app/$file" ]]; then
    mkdir -p "$backup/$(dirname "$file")"
    cp "$app/$file" "$backup/$file"
  else
    touch "$backup/.absent/${file//\//__}"
  fi
  install -D -m 0644 "$stage/$file" "$app/$file"
done

cd "$app"
npx tsx scripts/test-published-terminal-subtype.mjs
npx tsx scripts/test-last-mile-gates.mjs

trap - ERR
printf 'BACKUP=%s\n' "$backup"
sha256sum "${files[@]}"
