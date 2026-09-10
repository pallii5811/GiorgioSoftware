#!/usr/bin/env python3
"""Compare immutable 117 published-legacy baseline vs live DB + current 877 shadow scan.
Read-only. Exit 0 always; prints JSON summary.
"""
import json, os, re, sqlite3, hashlib
from collections import Counter
from datetime import datetime, timezone

BASE = "/opt/leadsniper/backups/published-legacy-baseline-20260721T155725Z/published-legacy-baseline.json"
MANIFEST = "/opt/leadsniper/backups/published-legacy-baseline-20260721T155725Z/MANIFEST.json"
LIVE_DB = "/opt/leadsniper/prisma/dev.db"
CP = "/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"
RES = "/opt/leadsniper-revalidate/data/revalidation/results"
OUT = "/opt/leadsniper-revalidate/data/revalidation/BASELINE117_REGRESSION_NOW.json"

def pub_family(ps):
    if not ps:
        return False
    return bool(re.search(r"PUBLISHED|SELF_INSURANCE", ps, re.I))

def extract_ps_from_evidence(ev):
    if not ev:
        return None
    m = re.search(r"\[(?:PS|STATE):([^\]]+)\]", ev, re.I)
    if m:
        return m.group(1).strip()
    m2 = re.search(r"^\[V:(\w+)\]", ev)
    if m2:
        v = m2.group(1).upper()
        if v == "PUBLISHED":
            return "PUBLISHED_LEGACY_MARKER"
        if v == "HOT":
            return "HOT_LEGACY_MARKER"
        return v
    return None

raw = json.load(open(BASE))
records = raw.get("records") or raw.get("leads") or (raw if isinstance(raw, list) else [])
assert len(records) == 117, f"baseline count {len(records)} != 117"

# checksum guard
sha = hashlib.sha256(open(BASE, "rb").read()).hexdigest()
man = json.load(open(MANIFEST)) if os.path.isfile(MANIFEST) else {}
expected = (man.get("checksums") or {}).get("published-legacy-baseline.json")

cp = json.load(open(CP)) if os.path.isfile(CP) else {}
term = cp.get("terminal") or {}
retry = cp.get("retryQueue") or {}
inp = cp.get("inProgress") or {}

live_con = sqlite3.connect(f"file:{LIVE_DB}?mode=ro", uri=True)
live_con.row_factory = sqlite3.Row

buckets = Counter()
rows_out = []
live_regressions = []
shadow_regressions = []
shadow_confirmed = []
not_yet = []

for rec in records:
    lid = rec.get("leadId") or rec.get("id")
    old_ps = rec.get("statoValidazione") or rec.get("processingState") or ""
    old_name = rec.get("struttura") or rec.get("companyName") or ""
    old_docs = rec.get("urlDocumentoOPagina") or ""

    # LIVE
    live = live_con.execute(
        "SELECT id, companyName, evidence, status, policyFound FROM Lead WHERE id=?",
        (lid,),
    ).fetchone()
    live_ps = extract_ps_from_evidence(live["evidence"] if live else "") if live else None
    live_ok = bool(live) and (
        pub_family(live_ps)
        or (live and re.search(r"\[V:PUBLISHED\]|PUBLISHED", live["evidence"] or "", re.I))
    )
    if not live:
        live_status = "LIVE_MISSING"
        live_regressions.append({"id": lid, "name": old_name, "old": old_ps})
    elif not live_ok:
        live_status = "LIVE_REGRESSION"
        live_regressions.append(
            {"id": lid, "name": live["companyName"] or old_name, "old": old_ps, "live_ps": live_ps}
        )
    else:
        live_status = "LIVE_OK"

    # SHADOW / current scan
    shadow_ps = None
    shadow_where = None
    if lid in term:
        shadow_where = "terminal"
        shadow_ps = (term[lid] or {}).get("processingState")
    elif lid in retry:
        shadow_where = "retry"
        shadow_ps = "RETRY_PENDING"
    elif lid in inp:
        shadow_where = "inProgress"
        shadow_ps = "IN_PROGRESS"
    else:
        # result file only?
        rp = os.path.join(RES, f"{lid}.json")
        if os.path.isfile(rp):
            try:
                rr = json.load(open(rp))
                shadow_ps = rr.get("processingState") or rr.get("reasonCode")
                shadow_where = "result_file"
            except Exception:
                shadow_where = "none"
        else:
            shadow_where = "not_in_run_yet"

    if shadow_where in ("not_in_run_yet",):
        shadow_status = "NOT_YET_RESCANNED"
        not_yet.append(lid)
    elif shadow_where in ("retry", "inProgress"):
        shadow_status = "IN_FLIGHT"
    elif pub_family(shadow_ps) or shadow_ps == "HOT_VERIFIED":
        # published→HOT would be regression for legacy published set
        if pub_family(old_ps) and shadow_ps == "HOT_VERIFIED":
            shadow_status = "SHADOW_REGRESSION_TO_HOT"
            shadow_regressions.append(
                {"id": lid, "name": old_name, "old": old_ps, "shadow": shadow_ps, "where": shadow_where}
            )
        elif pub_family(old_ps) and pub_family(shadow_ps):
            shadow_status = "SHADOW_CONFIRMED_PUB_FAMILY"
            shadow_confirmed.append({"id": lid, "old": old_ps, "shadow": shadow_ps})
        else:
            shadow_status = f"SHADOW_{shadow_ps}"
    elif shadow_ps == "REVIEW_HUMAN":
        shadow_status = "SHADOW_REGRESSION_TO_REVIEW"
        shadow_regressions.append(
            {"id": lid, "name": old_name, "old": old_ps, "shadow": shadow_ps, "where": shadow_where}
        )
    elif shadow_ps == "TECHNICAL_BLOCKED":
        shadow_status = "SHADOW_TECHNICAL"
        shadow_regressions.append(
            {"id": lid, "name": old_name, "old": old_ps, "shadow": shadow_ps, "where": shadow_where}
        )
    elif shadow_ps and not pub_family(shadow_ps):
        shadow_status = "SHADOW_REGRESSION"
        shadow_regressions.append(
            {"id": lid, "name": old_name, "old": old_ps, "shadow": shadow_ps, "where": shadow_where}
        )
    else:
        shadow_status = "SHADOW_UNKNOWN"

    buckets[live_status] += 1
    buckets[shadow_status] += 1
    rows_out.append(
        {
            "id": lid,
            "name": old_name,
            "old_ps": old_ps,
            "live_status": live_status,
            "live_ps": live_ps,
            "shadow_status": shadow_status,
            "shadow_ps": shadow_ps,
            "shadow_where": shadow_where,
        }
    )

live_con.close()

# live db sha for APPLY_LIVE=0 proof
live_sha = hashlib.sha256(open(LIVE_DB, "rb").read()).hexdigest()

summary = {
    "ts": datetime.now(timezone.utc).isoformat(),
    "baseline": {
        "path": BASE,
        "count": len(records),
        "sha256": sha,
        "sha256_match_manifest": (expected == sha) if expected else None,
        "expected_sha": expected,
    },
    "live_db_sha256": live_sha,
    "apply_live_note": "Shadow run must not mutate live; LIVE_OK expected for all 117",
    "counts": dict(buckets),
    "live_regression_count": len(live_regressions),
    "live_regressions": live_regressions[:40],
    "shadow_regression_count": len(shadow_regressions),
    "shadow_regressions": shadow_regressions[:50],
    "shadow_confirmed_pub_count": len(shadow_confirmed),
    "not_yet_rescanned_count": len(not_yet),
    "checkpoint": {
        "terminal": len(term),
        "retry": len(retry),
        "inProgress": len(inp),
    },
    "verdict": (
        "PASS_LIVE_NO_REGRESSION"
        if len(live_regressions) == 0
        else "FAIL_LIVE_REGRESSION"
    ),
    "shadow_verdict": (
        "NO_SHADOW_REGRESSION_YET"
        if len(shadow_regressions) == 0
        else "SHADOW_HAS_DEMOTIONS"
    ),
}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump({"summary": summary, "rows": rows_out}, open(OUT, "w"), indent=2, ensure_ascii=False)
print(json.dumps(summary, indent=2, ensure_ascii=False))
print(f"\nFULL_REPORT={OUT}")
