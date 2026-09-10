#!/usr/bin/env python3
import json, os
from datetime import datetime, timezone
from collections import Counter

cp_path = "/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"
res_dir = "/opt/leadsniper-revalidate/data/revalidation/results"
cp = json.load(open(cp_path))
st = os.stat(cp_path)
print("now_utc", datetime.now(timezone.utc).isoformat())
print("checkpoint_mtime", datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat())
print("checkpoint_updatedAt", cp.get("updatedAt"))
print("stats", cp.get("stats"))
term = cp.get("terminal") or {}
inp = cp.get("inProgress") or {}
retry = cp.get("retryQueue") or {}
print("counts", {"terminal": len(term), "inProgress": len(inp), "retry": len(retry)})

print("\n=== inProgress ===")
for lid, v in inp.items():
    print(json.dumps({"id": lid, **(v if isinstance(v, dict) else {"raw": v})}, ensure_ascii=False)[:500])

print("\n=== retry reasons ===")
print(Counter((v or {}).get("lastReason") or "?" for v in retry.values()).most_common())

print("\n=== retry lastError top ===")
print(Counter(((v or {}).get("lastError") or "?")[:80] for v in retry.values()).most_common(10))

print("\n=== recent result files (mtime) ===")
files = []
for name in os.listdir(res_dir):
    if not name.endswith(".json") or name.endswith(".p1.json"):
        continue
    p = os.path.join(res_dir, name)
    files.append((os.path.getmtime(p), name))
files.sort(reverse=True)
for mt, name in files[:12]:
    row = json.load(open(os.path.join(res_dir, name)))
    print(
        datetime.fromtimestamp(mt, timezone.utc).isoformat(),
        name,
        row.get("processingState") or row.get("state"),
        "finishedAt=",
        row.get("finishedAt"),
        "company=",
        (row.get("companyName") or "")[:40],
    )

# when did terminals last grow?
print("\n=== terminal finishedAt histogram (hour) ===")
hours = Counter()
for lid, v in term.items():
    fa = (v or {}).get("finishedAt") if isinstance(v, dict) else None
    if fa:
        hours[fa[:13]] += 1
    else:
        hours["missing"] += 1
for h, n in sorted(hours.items()):
    print(h, n)

due = 0
now = datetime.now(timezone.utc).isoformat()
for lid, v in retry.items():
    nxt = (v or {}).get("nextRetryAt")
    if not nxt or nxt <= now:
        due += 1
print("\nretry_due_now", due, "of", len(retry))
