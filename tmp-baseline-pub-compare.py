#!/usr/bin/env python3
"""Regression check: published live set (proxy for missing immutable 117 file) vs shadow 877 scan.
Also: live DB must still show [V:PUB] for each ID (APPLY_LIVE=0).
"""
import csv, json, os, re, sqlite3, hashlib
from collections import Counter
from datetime import datetime, timezone

LIVE_DB = "/opt/leadsniper/prisma/dev.db"
CP = "/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"
RES = "/opt/leadsniper-revalidate/data/revalidation/results"
IDS_FILE = "/tmp/published-live-v1-ids.json"
CSV_APP = "/opt/leadsniper-revalidate/app/docs/human-review/published-baseline-final/published-baseline.csv"
OUT = "/opt/leadsniper-revalidate/data/revalidation/BASELINE117_REGRESSION_NOW.json"

def pub_family(ps):
    return bool(ps and re.search(r"PUBLISHED|SELF_INSURANCE", str(ps), re.I))

def extract_v(ev):
    if not ev:
        return None
    m = re.match(r"\[V:(\w+)\]", ev)
    return m.group(1) if m else None

def extract_ps(ev):
    if not ev:
        return None
    m = re.search(r"\[(?:PS|STATE):([^\]]+)\]", ev, re.I)
    return m.group(1).strip() if m else None

# Prefer CSV human-review baseline (verdict_storico=PUBLISHED) if present; else ids file; else live V:PUB
ids = []
source = None
if os.path.isfile(CSV_APP):
    with open(CSV_APP, newline="", encoding="utf-8", errors="replace") as f:
        for row in csv.DictReader(f):
            if (row.get("verdict_storico") or "").upper() == "PUBLISHED" and row.get("leadId"):
                ids.append(row["leadId"])
    source = f"csv:{CSV_APP}"
elif os.path.isfile(IDS_FILE):
    d = json.load(open(IDS_FILE))
    ids = list(d.get("ids") or [])
    source = f"ids_file:{IDS_FILE}"

con = sqlite3.connect(f"file:{LIVE_DB}?mode=ro", uri=True)
con.row_factory = sqlite3.Row

# Always also collect current live V:PUB
live_pub_ids = []
for r in con.execute("SELECT id, evidence FROM Lead"):
    if extract_v(r["evidence"] or "") == "PUB":
        live_pub_ids.append(r["id"])

if not ids:
    ids = live_pub_ids
    source = "live_V:PUB_reconstructed"

ids = list(dict.fromkeys(ids))  # dedupe preserve order

cp = json.load(open(CP))
term = cp.get("terminal") or {}
retry = cp.get("retryQueue") or {}
inp = cp.get("inProgress") or {}

buckets = Counter()
live_regressions = []
shadow_regressions = []
shadow_ok = []
in_flight = []
not_in_run = []
rows = []

for lid in ids:
    live = con.execute(
        "SELECT id, companyName, evidence, status, policyFound FROM Lead WHERE id=?", (lid,)
    ).fetchone()
    if not live:
        live_status = "LIVE_MISSING"
        live_regressions.append({"id": lid})
        live_v = None
        live_ps = None
        name = ""
    else:
        name = live["companyName"] or ""
        live_v = extract_v(live["evidence"] or "")
        live_ps = extract_ps(live["evidence"] or "")
        if live_v == "PUB" or pub_family(live_ps) or live["policyFound"]:
            live_status = "LIVE_OK_PUB"
        else:
            live_status = "LIVE_REGRESSION"
            live_regressions.append({"id": lid, "name": name, "live_v": live_v, "live_ps": live_ps})

    shadow_ps = None
    where = "not_in_877_yet"
    if lid in term:
        where = "terminal"
        shadow_ps = (term[lid] or {}).get("processingState")
    elif lid in retry:
        where = "retry"
        shadow_ps = "RETRY_PENDING:" + str((retry[lid] or {}).get("lastReason") or "")
    elif lid in inp:
        where = "inProgress"
        shadow_ps = "IN_PROGRESS"
    else:
        rp = os.path.join(RES, f"{lid}.json")
        if os.path.isfile(rp):
            try:
                rr = json.load(open(rp))
                shadow_ps = rr.get("processingState") or rr.get("reasonCode")
                where = "result_only"
            except Exception:
                pass

    if where == "not_in_877_yet":
        shadow_status = "NOT_YET_IN_877"
        not_in_run.append(lid)
    elif where in ("retry", "inProgress"):
        shadow_status = "IN_FLIGHT"
        in_flight.append({"id": lid, "name": name, "shadow": shadow_ps})
    elif pub_family(shadow_ps):
        shadow_status = "SHADOW_CONFIRMED_PUB"
        shadow_ok.append({"id": lid, "name": name, "shadow": shadow_ps})
    elif shadow_ps == "HOT_VERIFIED":
        shadow_status = "SHADOW_REGRESSION_TO_HOT"
        shadow_regressions.append({"id": lid, "name": name, "shadow": shadow_ps, "where": where})
    elif shadow_ps == "REVIEW_HUMAN":
        shadow_status = "SHADOW_TO_REVIEW"
        shadow_regressions.append({"id": lid, "name": name, "shadow": shadow_ps, "where": where})
    elif shadow_ps == "TECHNICAL_BLOCKED":
        shadow_status = "SHADOW_TECHNICAL"
        shadow_regressions.append({"id": lid, "name": name, "shadow": shadow_ps, "where": where})
    elif shadow_ps:
        shadow_status = "SHADOW_OTHER"
        shadow_regressions.append({"id": lid, "name": name, "shadow": shadow_ps, "where": where})
    else:
        shadow_status = "SHADOW_UNKNOWN"

    buckets[live_status] += 1
    buckets[shadow_status] += 1
    rows.append({
        "id": lid,
        "name": name,
        "live_status": live_status,
        "live_v": live_v,
        "shadow_status": shadow_status,
        "shadow_ps": shadow_ps,
        "where": where,
    })

con.close()
live_sha = hashlib.sha256(open(LIVE_DB, "rb").read()).hexdigest()

# overlap note: immutable 117 file missing
summary = {
    "ts": datetime.now(timezone.utc).isoformat(),
    "note": (
        "Immutable published-legacy-baseline.json (117) MISSING on this server "
        "(/opt/leadsniper/backups/... gone). Using published baseline CSV / live V:PUB as proxy. "
        "Historical check 2026-07-23: live regressionCount=0 on true 117."
    ),
    "baseline_source": source,
    "baseline_count": len(ids),
    "live_V_PUB_count_now": len(live_pub_ids),
    "live_db_sha256": live_sha,
    "counts": dict(buckets),
    "live_regression_count": len(live_regressions),
    "live_regressions": live_regressions[:30],
    "shadow_regression_count": len(shadow_regressions),
    "shadow_regressions": shadow_regressions[:40],
    "shadow_confirmed_pub_count": len(shadow_ok),
    "in_flight_count": len(in_flight),
    "not_yet_in_877_count": len(not_in_run),
    "checkpoint": {"terminal": len(term), "retry": len(retry), "inProgress": len(inp)},
    "verdict_live": "PASS" if len(live_regressions) == 0 else "FAIL",
    "verdict_shadow": (
        "PASS_NO_DEMOTIONS" if len(shadow_regressions) == 0
        else "HAS_DEMOTIONS_OR_NON_PUB"
    ),
}

json.dump({"summary": summary, "rows": rows}, open(OUT, "w"), indent=2, ensure_ascii=False)
print(json.dumps(summary, indent=2, ensure_ascii=False))
print("FULL=" + OUT)
