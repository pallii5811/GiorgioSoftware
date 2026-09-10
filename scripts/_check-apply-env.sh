#!/usr/bin/env bash
set -euo pipefail
python3 <<'PY'
import json
from pathlib import Path
cp = json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
print("applyLive", cp.get("applyLive"), "flags", cp.get("flags"))
print("startedAt", cp.get("startedAt"))
print("stats", cp.get("stats"))
print("term", len(cp.get("terminal") or {}), "retry", len(cp.get("retryQueue") or {}), "ip", len(cp.get("inProgress") or {}))
# baseline published live count if present in results
PY
grep -E 'APPLY_LIVE|applyLive|REVALIDATE_APPLY' /etc/systemd/system/giorgio-revalidate.service /etc/systemd/system/giorgio-revalidate.service.d/*.conf 2>/dev/null || true
# unit env effective
systemctl show giorgio-revalidate -p Environment --value | tr ' ' '\n' | grep -E 'APPLY|CONCURRENCY|SLICE|WALL|HTML_URL|MAX_HTML|PER_HOST' || true
