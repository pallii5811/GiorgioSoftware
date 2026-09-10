#!/usr/bin/env bash
set -euo pipefail
echo '=== procs ==='
pgrep -af 'k3-micro|revalidate-sanita' | head -20 || true
echo '=== worker env ==='
WP=$(pgrep -f 'production-revalidate-sanita-worker.mjs' | head -1 || true)
echo "WP=$WP"
if [ -n "${WP:-}" ] && [ -r "/proc/$WP/environ" ]; then
  tr '\0' '\n' < "/proc/$WP/environ" | grep -E 'FORCE_RESCAN|REVALIDATE_LEAD|OCR_ENABLED|PDFTOPPM' || true
fi
echo '=== chrome ==='
pgrep -c -f chrome-headless-shell || echo 0
echo '=== log tail ==='
tail -20 /opt/leadsniper-revalidate/data/k3-stopship/micro-canary10-run2.log
echo '=== worker_done ==='
grep -E 'worker_done|k3_progress|k3_audit|OCR_RENDERER' /opt/leadsniper-revalidate/data/k3-stopship/micro-canary10-run2.log || echo none_yet
echo '=== results ==='
test -f /opt/leadsniper-revalidate/data/k3-stopship/MICRO_CANARY10_RESULTS.json && python3 -c 'import json; d=json.load(open("/opt/leadsniper-revalidate/data/k3-stopship/MICRO_CANARY10_RESULTS.json")); print(d.get("verdict"), d.get("gate"))' || echo no_final_results
