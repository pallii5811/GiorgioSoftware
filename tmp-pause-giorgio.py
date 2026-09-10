#!/usr/bin/env python3
import json
import hashlib
import subprocess
from pathlib import Path

subprocess.check_call(["systemctl", "stop", "giorgio-revalidate"])
import time
time.sleep(2)
active = subprocess.check_output(["systemctl", "is-active", "giorgio-revalidate"], text=True, stderr=subprocess.STDOUT).strip() if False else None
try:
    active = subprocess.check_output(["systemctl", "is-active", "giorgio-revalidate"], text=True).strip()
except subprocess.CalledProcessError as e:
    active = e.output.strip() if e.output else "inactive"

cp_path = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
raw = cp_path.read_bytes()
sha = hashlib.sha256(raw).hexdigest()
cp = json.loads(raw)
print(json.dumps({
    "service": active,
    "checkpoint_sha256": sha,
    "terminal": len(cp.get("terminal") or {}),
    "retry": len(cp.get("retryQueue") or {}),
    "inProgress": list((cp.get("inProgress") or {}).keys()),
    "updatedAt": cp.get("updatedAt"),
}, indent=2))

# DB SHA if present
for p in [
    Path("/opt/leadsniper-revalidate/data/prisma/dev.db"),
    Path("/opt/leadsniper-revalidate/app/prisma/dev.db"),
]:
    if p.exists():
        h = hashlib.sha256(p.read_bytes()).hexdigest()
        print(f"db {p} sha256={h} size={p.stat().st_size}")

# git
app = Path("/opt/leadsniper-revalidate/app")
if (app / ".git").exists():
    print("git", subprocess.check_output(["git", "-C", str(app), "rev-parse", "HEAD"], text=True).strip())
