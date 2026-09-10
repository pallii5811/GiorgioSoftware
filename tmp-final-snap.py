#!/usr/bin/env python3
import hashlib, json, subprocess
from pathlib import Path

def sha(p):
    p = Path(p)
    h = hashlib.sha256()
    with p.open("rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()

T = Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun")
b = json.loads((T / "baseline.json").read_text())
cp = json.loads((T / "checkpoint.json").read_text())
print(json.dumps({
    "term": len(cp.get("terminal") or {}),
    "retry": len(cp.get("retryQueue") or {}),
    "ip": list((cp.get("inProgress") or {}).keys()),
    "states": {k: v.get("processingState") for k, v in (cp.get("terminal") or {}).items()},
    "retryMeta": {k: {"attempts": m.get("attempts"), "reason": m.get("lastReason"), "next": m.get("nextRetryAt")} for k, m in (cp.get("retryQueue") or {}).items()},
    "db_ok": sha(b["dbPath"]) == b["dbSha"],
    "cp_ok": sha("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json") == b["prodCheckpointSha"],
    "db_sha": sha(b["dbPath"]),
    "cp_sha": sha("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"),
    "baseline_db": b["dbSha"],
    "baseline_cp": b["prodCheckpointSha"],
    "giorgio": subprocess.getoutput("systemctl is-active giorgio-revalidate"),
    "RELEASE": Path("/opt/leadsniper-revalidate/app/RELEASE_SHA").read_text().strip(),
}, indent=2))
