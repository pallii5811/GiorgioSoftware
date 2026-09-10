#!/usr/bin/env python3
"""Progress on HOT_SMALL_CRAWL_AUDIT requeues + sample mechanical gates on remaining HOT."""
import json, os, re
from collections import Counter

CP = "/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"
RES = "/opt/leadsniper-revalidate/data/revalidation/results"
cp = json.load(open(CP))
rq = cp.get("retryQueue") or {}
term = cp.get("terminal") or {}
inp = cp.get("inProgress") or {}

audit = {k: v for k, v in rq.items() if "HOT_SMALL" in str(v.get("lastReason") or "")}
print("audit_still_in_retry", len(audit))
print("inProgress_ids", list(inp.keys())[:5], "n=", len(inp))

# mechanical gates on remaining HOT
bad = []
gates = Counter()
for lid, meta in term.items():
    if meta.get("processingState") != "HOT_VERIFIED":
        continue
    path = os.path.join(RES, f"{lid}.json")
    if not os.path.exists(path):
        bad.append((lid, "NO_RESULT"))
        continue
    r = json.load(open(path))
    ev = r.get("fullEvidence") or ""
    pf = r.get("policyFound")
    cc = r.get("crawlComplete")
    if pf is True:
        bad.append((lid, "policyFound=true", r.get("companyName")))
        gates["policyFound_true"] += 1
    if cc is False:
        bad.append((lid, "crawlComplete=false", r.get("companyName")))
        gates["crawl_incomplete"] += 1
    if "FRONTIER:OPEN" in ev:
        bad.append((lid, "FRONTIER_OPEN", r.get("companyName")))
        gates["frontier_open"] += 1
    if re.search(r"polizza\s+n|numero\s+polizza|amtrust|scheda\s+di\s+polizza", ev, re.I):
        bad.append((lid, "ev_policy_phrase", r.get("companyName")))
        gates["ev_policy_phrase"] += 1
    gates["hot_checked"] += 1

print("mechanical_gates", dict(gates))
print("mechanical_bad", len(bad))
for b in bad[:30]:
    print(" ", b)

# wrong site reviews
wr = [
    (k, v.get("reasonCode"), v.get("processingState"))
    for k, v in term.items()
    if "WRONG_SITE" in str(v.get("reasonCode") or "") or "WRONG_HOST" in str(v.get("reasonCode") or "")
]
print("wrong_site_reviews", len(wr))
for x in wr:
    print(" ", x)
