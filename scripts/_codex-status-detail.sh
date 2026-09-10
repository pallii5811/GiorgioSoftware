#!/usr/bin/env bash
set -euo pipefail

systemctl is-active giorgio-revalidate
systemctl show giorgio-revalidate \
  -p NRestarts \
  -p ActiveEnterTimestamp \
  -p MemoryCurrent \
  -p MemoryPeak \
  -p MemorySwapCurrent \
  -p MemorySwapPeak

python3 - <<'PY'
import json
from collections import Counter

checkpoint_path = "/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"
with open(checkpoint_path, encoding="utf-8") as handle:
    checkpoint = json.load(handle)

states = Counter(
    str(meta.get("processingState") or "")
    for meta in checkpoint.get("terminal", {}).values()
)
print(json.dumps({
    "terminal": len(checkpoint.get("terminal", {})),
    "retry": len(checkpoint.get("retryQueue", {})),
    "inProgress": len(checkpoint.get("inProgress", {})),
    "states": states,
    "stats": checkpoint.get("stats"),
}, indent=2))

result_path = (
    "/opt/leadsniper-revalidate/data/revalidation/results/"
    "cmqo5cef9001waa3vcfes6vw0.json"
)
with open(result_path, encoding="utf-8") as handle:
    row = json.load(handle)
print(json.dumps({
    key: row.get(key)
    for key in (
        "id",
        "companyName",
        "processingState",
        "publishedSubtype",
        "policyFound",
        "policyExpiry",
        "reasonCode",
        "crawlComplete",
    )
}, indent=2))
print((row.get("fullEvidence") or "")[:800])
PY
