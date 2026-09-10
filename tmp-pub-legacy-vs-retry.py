#!/usr/bin/env python3
"""Where are the ~122 legacy PUBLISHED now? And what really blocks the retry queue."""
import json, re, sqlite3
from collections import Counter
from pathlib import Path

CP = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
RES = Path("/opt/leadsniper-revalidate/data/revalidation/results")
DB = "/opt/leadsniper/prisma/dev.db"

cp = json.loads(CP.read_text(encoding="utf-8"))
term = cp.get("terminal") or {}
rq = cp.get("retryQueue") or {}
inp = cp.get("inProgress") or {}

con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
cols = [r[1] for r in con.execute("pragma table_info(Lead)")]
has = lambda c: c in cols

# legacy published = evidence tag [V:PUB] or policyFound=1
q = "select id, companyName, website, policyFound, evidence from Lead where type='HEALTHCARE'"
legacy_pub = []
for lid, name, web, pf, ev in con.execute(q):
    ev = ev or ""
    is_pub = bool(pf) or "[V:PUB]" in ev or "V:PUB" in ev
    if is_pub:
        legacy_pub.append((lid, name, web, bool(pf)))

print("legacy_published_in_live_db", len(legacy_pub))

buckets = Counter()
still_open = []
regressed = []
for lid, name, web, pf in legacy_pub:
    if lid in term:
        st = term[lid].get("processingState")
        buckets[f"terminal:{st}"] += 1
        if st == "HOT_VERIFIED":
            regressed.append((name, web, lid))
    elif lid in rq:
        buckets["retry"] += 1
        still_open.append((name, web, lid, str(rq[lid].get("lastReason"))[:50]))
    elif lid in inp:
        buckets["running"] += 1
    else:
        buckets["NOT_YET_TOUCHED"] += 1
        still_open.append((name, web, lid, "not_started"))

print("legacy_pub_status", json.dumps(dict(buckets.most_common()), indent=2))
print("legacy_pub_regressed_to_HOT", len(regressed))
for r in regressed[:20]:
    print("  HOT_NOW:", r[0], r[1])
print("legacy_pub_not_yet_certified", len(still_open))
for s in still_open[:15]:
    print("  OPEN:", s[0], "|", s[3])

# ---- retry queue anatomy ----
print("\n=== RETRY ANATOMY ===")
fam = Counter()
identity_samples = []
for lid, v in rq.items():
    reason = str(v.get("lastReason") or "")
    err = str(v.get("lastError") or "")
    blob = f"{reason} {err}"
    if "IDENTITY" in blob.upper():
        fam["IDENTITY"] += 1
        if len(identity_samples) < 25:
            resp = RES / f"{lid}.json"
            nm = web = None
            evid = ""
            if resp.exists():
                r = json.loads(resp.read_text(encoding="utf-8"))
                nm, web = r.get("companyName"), r.get("website")
                evid = (r.get("fullEvidence") or "")[:200]
            identity_samples.append((nm, web, reason[:60], evid[:120]))
    else:
        fam[reason.split(":")[0][:40] or "?"] += 1

print("retry_families", json.dumps(dict(fam.most_common(12)), indent=2))
print("\nIDENTITY samples (candidate FALSE 'sito errato'):")
for s in identity_samples:
    print(f"  {str(s[0])[:45]:45s} {str(s[1])[:45]:45s} {s[2]}")
