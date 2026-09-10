#!/usr/bin/env bash
set -euo pipefail

app="/opt/leadsniper-revalidate/app"
data="/opt/leadsniper-revalidate/data/revalidation"
staging="/tmp/codex-villa-fiorita-attribution"
lead_id="cmqmano01002n9g5c9h0qjxhl"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="/opt/leadsniper-revalidate/backups/villa-fiorita-attribution-$stamp"
files=(
  "src/lib/sanita/entity-fingerprint.ts"
  "scripts/test-entity-fingerprint.mjs"
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
npx tsx scripts/test-entity-fingerprint.mjs
npx tsx scripts/test-published-defense.mjs
npx tsx scripts/test-hot-proof.mjs

python3 - "$data/checkpoint.json" "$lead_id" <<'PY'
import json
import os
import sys
import tempfile

path, lead_id = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as handle:
    checkpoint = json.load(handle)
retry = checkpoint.get("retryQueue", {}).get(lead_id)
if retry is None:
    raise RuntimeError(f"target missing from retryQueue: {lead_id}")
retry["lastReason"] = "PUBLISHED_EXPIRED_RECERTIFICATION"
retry["lastError"] = "PUBLISHED_EXPIRED_RECERTIFICATION"
retry["nextRetryAt"] = "0001-01-01T00:00:00.000Z"
retry["forceDue"] = True
retry["operational"] = True
retry["continuationReady"] = False
retry["parked"] = False
retry["parkedReason"] = None
directory = os.path.dirname(path)
fd, temporary = tempfile.mkstemp(prefix=".checkpoint.", suffix=".tmp", dir=directory)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(checkpoint, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY

previous_release="$(cat "$backup/RELEASE_SHA")"
entity_hash="$(sha256sum src/lib/sanita/entity-fingerprint.ts | cut -d' ' -f1)"
release_fingerprint="$(
  printf '%s\n%s\n' "$previous_release" "$entity_hash" |
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
