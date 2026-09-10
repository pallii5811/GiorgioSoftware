#!/usr/bin/env bash
set -euo pipefail

app="/opt/leadsniper-revalidate/app"
data="/opt/leadsniper-revalidate/data/revalidation"
staging="/tmp/codex-stall-convergence"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="/opt/leadsniper-revalidate/backups/stall-convergence-$stamp"
files=(
  "src/lib/sanita/policy-verify.ts"
  "src/lib/sanita/scan-engine.ts"
  "src/lib/sanita/ocr.ts"
  "src/lib/sanita/crawl-slice-runner.ts"
  "scripts/revalidate-checkpoint-v3.mjs"
  "scripts/test-revalidation-v3.mjs"
  "scripts/test-published-defense.mjs"
  "scripts/test-image-visual-classifier.mjs"
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
npx tsx scripts/test-frontier-evidence.mjs
npx tsx scripts/test-exhaustive-site-coverage.mjs
npx tsx scripts/test-image-visual-classifier.mjs
npx tsx scripts/test-stopship-no-tech-terminal.mjs

# The positive proofs were already fetched and isolated. Make only those rows
# immediately eligible so the new terminal classifier can drain them first.
python3 - "$data/checkpoint.json" <<'PY'
import json
import os
import sys
import tempfile

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as handle:
    checkpoint = json.load(handle)
forced = 0
for meta in checkpoint.get("retryQueue", {}).values():
    reason = str(meta.get("lastReason") or "")
    if reason == "SELF_INSURANCE_VERIFIED" or reason.startswith("PUBLISHED_"):
        meta["nextRetryAt"] = "1970-01-01T00:00:00.000Z"
        meta["parked"] = False
        meta["forceDue"] = True
        forced += 1
checkpoint["updatedAt"] = __import__("datetime").datetime.now(
    __import__("datetime").timezone.utc
).isoformat().replace("+00:00", "Z")
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
print(f"FORCED_POSITIVE_ROWS={forced}")
PY

release_fingerprint="$(
  sha256sum \
    src/lib/sanita/policy-verify.ts \
    src/lib/sanita/scan-engine.ts \
    src/lib/sanita/ocr.ts \
    src/lib/sanita/crawl-slice-runner.ts \
    scripts/revalidate-checkpoint-v3.mjs |
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
