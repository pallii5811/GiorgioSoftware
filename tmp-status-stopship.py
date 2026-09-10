#!/usr/bin/env python3
import hashlib
import json
import subprocess
from pathlib import Path

def sha(p):
    p = Path(p)
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None

prod = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
base = json.loads(Path("/opt/leadsniper-revalidate/data/stopship-canary20/baseline.json").read_text())
cp = json.loads(prod.read_text())
canary = Path("/opt/leadsniper-revalidate/data/stopship-canary20/checkpoint.json")
ccp = json.loads(canary.read_text()) if canary.exists() else {}
svc = subprocess.run(["systemctl", "is-active", "giorgio-revalidate"], capture_output=True, text=True)
print(
    json.dumps(
        {
            "giorgio_revalidate": (svc.stdout or svc.stderr or "").strip(),
            "prod_cp_sha_now": sha(prod),
            "prod_cp_sha_base": base.get("prodCheckpointSha"),
            "prod_cp_unchanged": sha(prod) == base.get("prodCheckpointSha"),
            "db_sha_base": base.get("dbSha"),
            "db_sha_now": sha(base.get("dbPath") or ""),
            "db_unchanged": sha(base.get("dbPath") or "") == base.get("dbSha"),
            "prod_terminal": len(cp.get("terminal") or {}),
            "canary_terminal": len(ccp.get("terminal") or {}),
            "canary_retry": len(ccp.get("retryQueue") or {}),
            "canary_inProgress": list((ccp.get("inProgress") or {}).keys()),
            "canary_updatedAt": ccp.get("updatedAt"),
        },
        indent=2,
    )
)
