#!/usr/bin/env bash
set -euo pipefail

task_backup="/opt/leadsniper-revalidate/backups/frontiers-before-evidence-v2-20260727T2035Z"
case "$task_backup" in
  /opt/leadsniper-revalidate/backups/*) ;;
  *) echo "unsafe backup target" >&2; exit 1 ;;
esac

trap 'systemctl start giorgio-revalidate >/dev/null 2>&1 || true' EXIT
systemctl stop giorgio-revalidate
mkdir -p "$task_backup"
cp -a /opt/leadsniper-revalidate/data/revalidation/frontiers \
  "$task_backup/frontiers"
cp /opt/leadsniper-revalidate/data/revalidation/checkpoint.json \
  "$task_backup/checkpoint.json"
du -sh "$task_backup"
systemctl start giorgio-revalidate
systemctl is-active giorgio-revalidate
trap - EXIT
