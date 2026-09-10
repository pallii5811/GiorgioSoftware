#!/usr/bin/env bash
set -euo pipefail
META=/opt/leadsniper/backups/giorgio-live-20260720T165135Z.meta.json
python3 - <<'PY'
import json
for p in [
 "/opt/leadsniper/backups/giorgio-live-20260720T165135Z.meta.json",
 "/opt/leadsniper/backups/giorgio-live-20260718.meta.json",
]:
  try:
    m=json.load(open(p))
    print(p, json.dumps({k:m.get(k) for k in ["integrity","restoreTest","sha256","path","createdAt","leadTotal"]}, default=str))
  except Exception as e:
    print(p, "ERR", e)
PY
