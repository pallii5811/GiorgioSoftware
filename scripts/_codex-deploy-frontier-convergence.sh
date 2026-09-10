#!/usr/bin/env bash
set -euo pipefail

app="/opt/leadsniper-revalidate/app"
data="/opt/leadsniper-revalidate/data/revalidation"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="/opt/leadsniper-revalidate/backups/frontier-convergence-$stamp"
override="/etc/systemd/system/giorgio-revalidate.service.d/50-frontier-convergence.conf"
files=(
  "src/lib/sanita/crawl-slice-runner.ts"
  "src/lib/sanita/lead-crawl-runtime.ts"
  "src/lib/sanita/frontier-store.ts"
  "src/lib/sanita/site-resource.ts"
  "src/lib/sanita/ocr.ts"
  "src/lib/sanita/detector.ts"
  "scripts/revalidate-checkpoint-v3.mjs"
  "scripts/production-revalidate-sanita-v3.mjs"
  "scripts/_frontier_inspect.py"
  "scripts/test-revalidation-v3.mjs"
  "scripts/test-exhaustive-site-coverage.mjs"
  "scripts/test-image-visual-classifier.mjs"
  "scripts/test-frontier-evidence.mjs"
  "scripts/test-policy-variant-recall.mjs"
  "scripts/test-ocr-policy-after-page-12.mjs"
  "scripts/test-ocr-hybrid-policy-page.mjs"
  "scripts/test-stopship-no-tech-terminal.mjs"
  "scripts/test-hot-proof.mjs"
  "scripts/test-self-insurance.mjs"
  "scripts/test-ocr-contract.mjs"
)

restore_and_start() {
  for file in "${files[@]}"; do
    if [[ -f "$backup/app/$file" ]]; then
      install -D -m 0644 "$backup/app/$file" "$app/$file"
    fi
  done
  if [[ -f "$backup/50-frontier-convergence.conf" ]]; then
    install -D -m 0644 "$backup/50-frontier-convergence.conf" "$override"
  else
    rm -f "$override"
  fi
  if [[ -f "$backup/RELEASE_SHA" ]]; then
    install -m 0644 "$backup/RELEASE_SHA" "$app/RELEASE_SHA"
  fi
  systemctl daemon-reload
  systemctl start giorgio-revalidate || true
}
trap restore_and_start ERR

mkdir -p "$backup/app" "$backup/data"
python3 - "$data/checkpoint.json" "$backup/active-frontiers.txt" <<'PY'
import json
import sys
from pathlib import Path

checkpoint = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
paths = [
    metadata.get("frontierPath")
    for metadata in (checkpoint.get("inProgress") or {}).values()
    if metadata.get("frontierPath")
]
Path(sys.argv[2]).write_text("\n".join(paths), encoding="utf-8")
PY
systemctl stop giorgio-revalidate
for file in "${files[@]}"; do
  mkdir -p "$backup/app/$(dirname "$file")"
  if [[ -f "$app/$file" ]]; then
    cp "$app/$file" "$backup/app/$file"
  fi
  install -D -m 0644 "/tmp/codex-convergence/$(basename "$file")" "$app/$file"
done
cp "$data/checkpoint.json" "$backup/data/checkpoint.json"
cp "$app/RELEASE_SHA" "$backup/RELEASE_SHA"
if [[ -f "$override" ]]; then
  cp "$override" "$backup/50-frontier-convergence.conf"
fi

python3 - "$backup/active-frontiers.txt" "$backup/data" <<'PY'
import shutil
import sys
from pathlib import Path

target = Path(sys.argv[2])
for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    frontier = Path(line)
    if not frontier.is_file():
        continue
    for suffix in ("", "-wal", "-shm"):
        source = Path(str(frontier) + suffix)
        if source.is_file():
            shutil.copy2(source, target / source.name)
PY

cat >"$override" <<'EOF'
[Service]
Environment=TOTAL_WORKERS=2
Environment=REVALIDATE_CONCURRENCY=2
Environment=REVALIDATE_SLICE_WALL_MS=3300000
Environment=REVALIDATE_LEAD_WALL_MS=3300000
Environment=CRAWL_MAX_HTML_PER_SLICE=24
Environment=CRAWL_MAX_SLICES_PER_LEAD=1
Environment=PER_HOST_DELAY_MS=100
EOF

cd "$app"
npx tsx scripts/test-revalidation-v3.mjs
npx tsx scripts/test-exhaustive-site-coverage.mjs
npx tsx scripts/test-image-visual-classifier.mjs
npx tsx scripts/test-frontier-persistence.mjs
npx tsx scripts/test-frontier-evidence.mjs
npx tsx scripts/test-published-defense.mjs
npx tsx scripts/test-policy-variant-recall.mjs
npx tsx scripts/test-ocr-policy-after-page-12.mjs
npx tsx scripts/test-ocr-hybrid-policy-page.mjs
npx tsx scripts/test-stopship-no-tech-terminal.mjs
npx tsx scripts/test-hot-proof.mjs
npx tsx scripts/test-self-insurance.mjs
npx tsx scripts/test-ocr-contract.mjs

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

systemctl daemon-reload
trap - ERR
systemctl start giorgio-revalidate
systemctl is-active giorgio-revalidate
systemctl show giorgio-revalidate -p NRestarts -p MainPID --no-pager
echo "BACKUP=$backup"
sha256sum "${files[@]/#/$app/}"
