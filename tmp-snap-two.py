#!/usr/bin/env python3
import json
from pathlib import Path
cp=json.loads(Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun/checkpoint.json").read_text())
print(json.dumps({
  "giorgio": __import__("subprocess").getoutput("systemctl is-active giorgio-revalidate"),
  "RELEASE": Path("/opt/leadsniper-revalidate/app/RELEASE_SHA").read_text().strip() if Path("/opt/leadsniper-revalidate/app/RELEASE_SHA").exists() else None,
  "term": len(cp.get("terminal") or {}),
  "retry": list((cp.get("retryQueue") or {}).keys()),
  "ip": list((cp.get("inProgress") or {}).keys()),
  "malzoni": (cp.get("retryQueue") or {}).get("cmqklex5g00b6108ejom1shk0") or (cp.get("terminal") or {}).get("cmqklex5g00b6108ejom1shk0"),
  "medicanova": (cp.get("retryQueue") or {}).get("cmqmaf02a001k9g5crmkdun0w") or (cp.get("terminal") or {}).get("cmqmaf02a001k9g5crmkdun0w"),
}, indent=2, default=str))
