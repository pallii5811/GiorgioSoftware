#!/usr/bin/env bash
# Demote canary REVIEW_HUMAN terminals → retryQueue (due now) for RC-08 retest.
# Does NOT wipe other terminals / frontier / baseline.
set -euo pipefail
CP=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json
IDS="${1:-cmqklex5q00bh108eq9blm01k,cmqktyimz000i111hygme29nh,cmqkld5rk009b108ekvol7g87,cmql4d399000uc9w7yzw2dgac,cmql4qrif000yc9w74e0tmpqt}"
python3 - <<PY
import json, time
from pathlib import Path
cp_path=Path("$CP")
ids=[x for x in "$IDS".split(",") if x]
cp=json.loads(cp_path.read_text())
bak=cp_path.with_suffix(f".bak-rc08-{int(time.time())}.json")
bak.write_text(json.dumps(cp, indent=2))
now=time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
moved=0
for i in ids:
  t=cp.get("terminal",{}).pop(i, None)
  if not t:
    print("skip_not_terminal", i)
    continue
  cp.setdefault("retryQueue",{})[i]={
    "attempts": int((cp.get("retryQueue",{}).get(i) or {}).get("attempts") or 0),
    "nextRetryAt": now,
    "lastError": "RC08_RETEST_DEMOTION",
    "lastReason": t.get("processingState") or "REVIEW_HUMAN",
    "firstSeenAt": t.get("finishedAt") or now,
    "lastRunId": t.get("runId"),
    "frontierPath": t.get("frontierPath"),
  }
  moved+=1
  print("demoted", i, t.get("processingState"))
cp_path.write_text(json.dumps(cp, indent=2))
print("backup", bak)
print("moved", moved, "terminal", len(cp.get("terminal",{})), "retry", len(cp.get("retryQueue",{})))
PY
