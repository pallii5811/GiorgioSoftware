#!/usr/bin/env python3
"""HOT audit status from checkpoint.terminal + results."""
import json, os, re
from collections import Counter

CP = "/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"
RES = "/opt/leadsniper-revalidate/data/revalidation/results"

cp = json.load(open(CP))
term = cp.get("terminal") or {}
retry = cp.get("retryQueue") or {}
inp = cp.get("inProgress") or {}
stats = cp.get("stats") or {}

states = Counter(v.get("processingState") for v in term.values())
print("stats", stats)
print("terminal_by_state", dict(states.most_common()))
print("retryQueue", len(retry), "inProgress", len(inp))

hots = [k for k, v in term.items() if v.get("processingState") == "HOT_VERIFIED"]
print("HOT_VERIFIED", len(hots))

# size from fullEvidence n=
sized = []
for lid in hots:
    path = os.path.join(RES, f"{lid}.json")
    if not os.path.exists(path):
        sized.append((-1, lid, "NO_RESULT", "", 0, 0))
        continue
    r = json.load(open(path))
    ev = r.get("fullEvidence") or ""
    m = re.search(r"\bn=(\d+)", ev)
    n = int(m.group(1)) if m else -1
    pdf = 0
    m2 = re.search(r"pdf[s]?[=:](\d+)", ev, re.I)
    if m2:
        pdf = int(m2.group(1))
    sized.append((n, lid, r.get("companyName") or "?", r.get("website") or "", pdf, len(ev)))

sized.sort()
print(
    "HOT_size_buckets",
    {
        "n<=5": sum(1 for n, *_ in sized if 0 <= n <= 5),
        "6-19": sum(1 for n, *_ in sized if 6 <= n <= 19),
        "20-49": sum(1 for n, *_ in sized if 20 <= n <= 49),
        "50+": sum(1 for n, *_ in sized if n >= 50),
        "n_unknown": sum(1 for n, *_ in sized if n < 0),
    },
)

print("--- smallest HOT ---")
for row in sized[:35]:
    n, lid, name, web, pdf, evlen = row
    print(f"n={n:4d} pdf~{pdf}  {str(name)[:50]:50s}  {str(web)[:55]}")
    print(f"         id={lid}")

# audit markers in retry
audit_rq = []
for lid, v in retry.items():
    reason = str(v.get("lastReason") or "")
    if "HOT_SMALL" in reason or "AUDIT" in reason or "WRONG_HOST" in reason:
        audit_rq.append((lid, reason, v.get("attempts"), v.get("nextRetryAt")))
print("retry_with_audit_reason", len(audit_rq))
for x in audit_rq[:25]:
    print(" ", x)

# probe files if present
for p in ("/tmp/hot-small-probe.json", "/tmp/hot-large-probe.json", "/tmp/hot-small-audit.json"):
    if os.path.exists(p):
        d = json.load(open(p))
        if "solid" in d:
            print(p, "solid", len(d.get("solid") or []), "weak", len(d.get("weak") or []))
        elif "suspect" in d:
            print(p, "suspect", len(d.get("suspect") or []), "clean", len(d.get("clean") or []))
        elif "small" in d:
            print(p, "small", len(d.get("small") or []))
