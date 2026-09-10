#!/usr/bin/env bash
python3 <<'PY'
import json
from datetime import datetime, timezone
from pathlib import Path
c=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
ids=["cmqktyimz000i111hygme29nh","cmqklex5q00bh108eq9blm01k","cmql4qrif000yc9w74e0tmpqt","cmql4d399000uc9w7yzw2dgac","cmqkld5rk009b108ekvol7g87","cmqkld5s700a8108eti0nofjv","cmql46eia000ac9w78xh0rxdl","cmqmaor4t00389g5c2iuoauuw","cmqn40oou0002kwqdfi0ipn2g","cmqkld5s0009u108eghihpoxi"]
now=datetime.now(timezone.utc)
rq=c.get("retryQueue") or {}
term=c.get("terminal") or {}
ip=c.get("inProgress") or {}
print("now", now.isoformat())
for i in ids:
  if i in term:
    print(i, "TERMINAL", (term[i] or {}).get("processingState") if isinstance(term[i],dict) else term[i])
  elif i in ip:
    print(i, "IN_PROGRESS", ip[i])
  elif i in rq:
    meta=rq[i] if isinstance(rq[i],dict) else {}
    nra=meta.get("nextRetryAt")
    due=None
    if nra:
      try:
        due=datetime.fromisoformat(nra.replace("Z","+00:00"))
      except Exception as e:
        due=None
    print(i, "RETRY", meta.get("lastError") or meta.get("lastReason"), "nextRetryAt", nra, "due_in_s", (due-now).total_seconds() if due else None, "attempts", meta.get("attempts"))
  else:
    print(i, "UNKNOWN/pending")
PY
