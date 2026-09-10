#!/usr/bin/env bash
set -euo pipefail
python3 <<'PY'
import json, os
from collections import Counter
cp = json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
print("version", cp.get("version"))
print("startedAt", cp.get("startedAt"))
print("updatedAt", cp.get("updatedAt"))
print("testedCodeSha", cp.get("testedCodeSha"))
print("stats", json.dumps(cp.get("stats"), indent=2))
print("terminal_len", len(cp.get("terminal") or {}))
print("attempts_len", len(cp.get("attempts") or {}))
print("inProgress_len", len(cp.get("inProgress") or {}))
rq = cp.get("retryQueue") or []
print("retryQueue_len", len(rq) if hasattr(rq, "__len__") else type(rq))
term = Counter()
for v in (cp.get("terminal") or {}).values():
    if isinstance(v, dict):
        term[str(v.get("processingState") or v.get("state") or v.get("businessVerdict") or "?")] += 1
    else:
        term[str(v)] += 1
print("terminal_states", dict(term.most_common(20)))
res = "/opt/leadsniper-revalidate/data/revalidation/results"
n = 0
if os.path.isdir(res):
    for root, dirs, files in os.walk(res):
        n += sum(1 for f in files if f.endswith(".json"))
print("results_json_files", n)
ip = cp.get("inProgress") or {}
print("inProgress_ids", list(ip.keys())[:10])
# attempts sample keys
att = cp.get("attempts") or {}
print("attempts_sample", list(att.items())[:5])
PY
