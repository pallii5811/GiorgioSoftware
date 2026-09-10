#!/usr/bin/env bash
set -euo pipefail

task_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
task_backup="/opt/leadsniper-revalidate/backups/codex-exhaustive-site-${task_stamp}"
task_app="/opt/leadsniper-revalidate/app"
mkdir -p "$task_backup"

task_files=(
  "src/lib/sanita/site-resource.ts"
  "src/lib/sanita/office-document.ts"
  "src/lib/sanita/detector.ts"
  "src/lib/sanita/ocr.ts"
  "src/lib/sanita/frontier-store.ts"
  "src/lib/sanita/crawl-slice-runner.ts"
  "src/lib/sanita/sitemap-pipeline.ts"
  "src/lib/sanita/scan-engine.ts"
  "src/lib/sanita/can-emit-hot.ts"
  "src/lib/sanita/lead-completion.ts"
  "src/lib/sanita/lead-crawl-runtime.ts"
  "scripts/production-revalidate-sanita-worker.mjs"
  "scripts/production-revalidate-sanita-v3.mjs"
  "scripts/revalidate-checkpoint-v3.mjs"
)

for task_file in "${task_files[@]}"; do
  if [[ -f "$task_app/$task_file" ]]; then
    mkdir -p "$task_backup/app/$(dirname "$task_file")"
    cp "$task_app/$task_file" "$task_backup/app/$task_file"
  fi
done

mkdir -p "$task_backup/data/revalidation"
cp /opt/leadsniper-revalidate/data/revalidation/checkpoint.json \
  "$task_backup/data/revalidation/checkpoint.json"
cp -a /etc/systemd/system/giorgio-revalidate.service.d \
  "$task_backup/systemd-dropins"

systemctl stop giorgio-revalidate
echo "BACKUP=$task_backup"
systemctl is-active giorgio-revalidate || true
