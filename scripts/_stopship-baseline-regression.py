#!/usr/bin/env python3
"""Stop-ship: baseline 117 regression + retry root-cause sample. Read-only."""
import json, os, hashlib, sqlite3
from collections import Counter
from datetime import datetime, timezone

BASE_CANDIDATES = [
    "/opt/leadsniper/backups/published-legacy-baseline-20260721T155725Z",
    "/opt/leadsniper-revalidate/data/k3-stopship/backups/pre-877-20260723T025718Z",
]
RES = "/opt/leadsniper-revalidate/data/revalidation/results"
CP = "/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"
LIVE_DB = "/opt/leadsniper/prisma/dev.db"
SHADOW_DB = "/opt/leadsniper-revalidate/shadow-revalidate.db"

out = {
    "ts": datetime.now(timezone.utc).isoformat(),
    "baseline": {},
    "live": {},
    "shadow_vs_baseline": {},
    "retry": {},
    "crawl_cap_samples": [],
}

# find baseline json
base_json = None
base_dir = None
for d in BASE_CANDIDATES:
    for name in [
        "published-legacy-baseline.json",
        "baseline-published-legacy.json",
        "MANIFEST.json",
    ]:
        p = os.path.join(d, name)
        if os.path.isfile(p):
            base_dir, base_json = d, p
            break
    if base_json:
        break
    # search
    if os.path.isdir(d):
        for root, _, files in os.walk(d):
            for f in files:
                if "published" in f.lower() and f.endswith(".json") and "baseline" in f.lower():
                    base_dir, base_json = d, os.path.join(root, f)
                    break
            if base_json:
                break

# also common path
for p in [
    "/opt/leadsniper/backups/published-legacy-baseline-20260721T155725Z/published-legacy-baseline.json",
    "/opt/leadsniper/data/baseline-published-legacy-MANIFEST.json",
]:
    if os.path.isfile(p):
        base_json = p
        break

records = []
if base_json:
    raw = json.load(open(base_json))
    if isinstance(raw, list):
        records = raw
    elif isinstance(raw, dict):
        records = raw.get("records") or raw.get("leads") or raw.get("items") or []
        if not records and "leadId" in raw:
            records = [raw]
    out["baseline"] = {"path": base_json, "count": len(records)}
else:
    out["baseline"] = {"path": None, "count": 0, "error": "baseline json not found"}
    # list backups
    out["baseline"]["dirs"] = []
    for d in ["/opt/leadsniper/backups", "/opt/leadsniper-revalidate/data/k3-stopship/backups"]:
        if os.path.isdir(d):
            out["baseline"]["dirs"].append({d: os.listdir(d)[:30]})

ids = [r.get("leadId") or r.get("id") for r in records if (r.get("leadId") or r.get("id"))]
ids = [i for i in ids if i]

# Live DB: check those IDs still look published/actionable
live_states = Counter()
live_missing = []
regressions = []
if ids and os.path.isfile(LIVE_DB):
    con = sqlite3.connect(LIVE_DB)
    con.row_factory = sqlite3.Row
    for lid in ids:
        row = con.execute(
            "SELECT id, companyName, evidence, status, policyFound FROM Lead WHERE id=?",
            (lid,),
        ).fetchone()
        if not row:
            live_missing.append(lid)
            continue
        ev = row["evidence"] or ""
        import re
        m = re.search(r"\[(?:PS|STATE):([^\]]+)\]", ev, re.I)
        ps = m.group(1) if m else None
        if not ps:
            m2 = re.search(r"^\[V:(\w+)\]", ev)
            ps = ("PUBLISHED_CURRENT" if m2 and m2.group(1) == "PUBLISHED" else m2.group(1) if m2 else "UNKNOWN")
        live_states[ps] += 1
        old = next((r for r in records if (r.get("leadId") or r.get("id")) == lid), {})
        old_ps = old.get("statoValidazione") or old.get("processingState") or ""
        # regression: was PUBLISHED*, now not published-family
        if re.search(r"PUBLISHED", old_ps or "", re.I) and not re.search(r"PUBLISHED|SELF_INSURANCE", ps or "", re.I):
            # also check V:PUBLISHED legacy marker
            if not re.search(r"\[V:PUBLISHED\]|PUBLISHED", ev, re.I):
                regressions.append({"id": lid, "old": old_ps, "new": ps, "company": row["companyName"]})
    con.close()

out["live"] = {
    "checked": len(ids),
    "missing": live_missing[:20],
    "missingCount": len(live_missing),
    "states": dict(live_states),
    "regressions": regressions[:30],
    "regressionCount": len(regressions),
}

# Shadow terminal demotions of baseline IDs
cp = json.load(open(CP))
term = cp.get("terminal") or {}
retry = cp.get("retryQueue") or {}
shadow_reg = []
shadow_ok = []
for lid in ids:
    if lid in term:
        ps = term[lid].get("processingState") if isinstance(term[lid], dict) else str(term[lid])
        if ps and not any(x in ps for x in ("PUBLISHED", "SELF_INSURANCE", "HOT_VERIFIED")):
            if "REVIEW" in ps:
                shadow_reg.append({"id": lid, "shadow": ps, "kind": "review"})
            else:
                shadow_reg.append({"id": lid, "shadow": ps, "kind": "other"})
        else:
            shadow_ok.append({"id": lid, "shadow": ps})
    elif lid in retry:
        shadow_reg.append({"id": lid, "shadow": "RETRY", "kind": "retry", "err": (retry[lid] or {}).get("lastError")})

out["shadow_vs_baseline"] = {
    "baselineInTerminal": len(shadow_ok),
    "baselineDemotedOrRetryOrReview": shadow_reg[:40],
    "demotedCount": len(shadow_reg),
    "note": "applyLive=0: shadow demotion must NOT mutate live",
}

# retry summary
out["retry"] = {
    "count": len(retry),
    "errors": Counter(((v or {}).get("lastError") or "?") for v in retry.values()).most_common(),
    "terminal": len(term),
    "inProgress": list((cp.get("inProgress") or {}).keys()),
    "updatedAt": cp.get("updatedAt"),
}

# CRAWL_CAP samples
n = 0
for lid, v in retry.items():
    if (v or {}).get("lastError") != "CRAWL_CAP":
        continue
    p = os.path.join(RES, f"{lid}.json")
    if not os.path.isfile(p):
        continue
    row = json.load(open(p))
    ev = row.get("fullEvidence") or ""
    # extract cap markers
    markers = [line for line in ev.splitlines() if any(k in line.upper() for k in ("CAP", "URL", "SITEMAP", "FRONTIER", "WALL"))][-15:]
    out["crawl_cap_samples"].append(
        {
            "id": lid,
            "company": row.get("companyName"),
            "markers": markers,
            "tail": ev[-800:],
        }
    )
    n += 1
    if n >= 3:
        break

print(json.dumps(out, ensure_ascii=False, indent=2))
