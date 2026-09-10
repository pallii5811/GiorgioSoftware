#!/usr/bin/env bash
# Move orphan inProgress → retryQueue after graceful kill. Never deletes terminals/results.
set -euo pipefail
CP=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json
OUT=/tmp/stopship-forensic
mkdir -p "$OUT"
sha256sum "$CP" | tee "$OUT/cp-before-orphan.sha"
cp -a "$CP" "$OUT/checkpoint-before-orphan.json"

python3 - <<'PY'
import json, shutil
from datetime import datetime, timezone
from pathlib import Path
cp_path = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
c = json.loads(cp_path.read_text())
ip = c.get("inProgress") or {}
rq = c.get("retryQueue") or {}
print("inProgress_before", len(ip), list(ip.keys()))
moved = []
for lid, meta in list(ip.items()):
    entry = meta if isinstance(meta, dict) else {"raw": meta}
    entry["requeuedAt"] = datetime.now(timezone.utc).isoformat()
    entry["requeueReason"] = "orphan_after_sigterm_graceful_stop"
    # preserve prior attempt info
    rq[lid] = {**(rq.get(lid) if isinstance(rq.get(lid), dict) else {}), **entry, "attempts": (entry.get("attempts") or (rq.get(lid) or {}).get("attempts") or 0)}
    moved.append(lid)
    del ip[lid]
c["inProgress"] = ip
c["retryQueue"] = rq
c["updatedAt"] = datetime.now(timezone.utc).isoformat()
# atomic write
tmp = cp_path.with_suffix(".json.tmp")
tmp.write_text(json.dumps(c, ensure_ascii=False, indent=2), encoding="utf-8")
tmp.replace(cp_path)
print("moved_to_retry", moved)
print("inProgress_after", len(c["inProgress"]))
print("retry_after", len(c["retryQueue"]))
print("terminal", len(c.get("terminal") or {}))
print("processed", (c.get("stats") or {}).get("processed"))
PY

sha256sum "$CP" | tee "$OUT/cp-after-orphan.sha"
echo ORPHAN_REQUEUE_OK
