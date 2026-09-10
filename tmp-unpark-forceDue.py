#!/usr/bin/env python3
import json
from pathlib import Path

OUT = Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun")
LID = "cmqklex5g00b6108ejom1shk0"
cp_path = OUT / "checkpoint.json"
cp = json.loads(cp_path.read_text(encoding="utf-8"))
rq = cp["retryQueue"][LID]
rq["forceDue"] = True
rq["parkedEngineCeiling"] = False
rq["nextRetryAt"] = "2020-01-01T00:00:00.000Z"
# preserve attempts
print({"attempts": rq.get("attempts"), "forceDue": rq["forceDue"], "nextRetryAt": rq["nextRetryAt"], "lastRunId": rq.get("lastRunId")})
cp_path.write_text(json.dumps(cp, ensure_ascii=False, indent=2), encoding="utf-8")

# ensure medicanova stays REVIEW in terminal map if present
term = cp.get("terminal", {})
print("terminals", len(term), "medicanova_in_term", "cmqmaf02a001k9g5crmkdun0w" in term)
if "cmqmaf02a001k9g5crmkdun0w" in term:
    print("med_term", term["cmqmaf02a001k9g5crmkdun0w"])
