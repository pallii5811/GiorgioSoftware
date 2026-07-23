#!/usr/bin/env python3
"""Poll the frozen 20-retry sample until gate or timeout; write RETRY20_GATE.json."""
import json, os, time, sqlite3
from datetime import datetime, timezone

SAMPLE = "/opt/leadsniper-revalidate/data/k3-stopship/RETRY20_SAMPLE.json"
CP = "/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"
RES = "/opt/leadsniper-revalidate/data/revalidation/results"
OUT = "/opt/leadsniper-revalidate/data/k3-stopship/RETRY20_GATE.json"
LOG = "/opt/leadsniper-revalidate/logs/systemd-revalidate.log"

sample = json.load(open(SAMPLE))
ids = [r["leadId"] for r in sample["records"]]
term_before = sample["terminalBefore"]
retry_before = sample["retryBefore"]
t0 = time.time()
timeout_s = int(os.environ.get("GATE_TIMEOUT_S", "2400"))  # 40 min

COMMERCIAL = {
    "PUBLISHED_CURRENT",
    "PUBLISHED_EXPIRED",
    "PUBLISHED_DATE_UNKNOWN",
    "SELF_INSURANCE_VERIFIED",
    "HOT_VERIFIED",
    "REVIEW_HUMAN",
    "OUT_OF_SCOPE",
}

def snap():
    cp = json.load(open(CP))
    term = cp.get("terminal") or {}
    rq = cp.get("retryQueue") or {}
    rows = []
    for r in sample["records"]:
        lid = r["leadId"]
        st = None
        kind = None
        wall = None
        err = None
        if lid in term:
            st = term[lid].get("processingState")
            kind = "terminal"
        elif lid in rq:
            st = "RETRY_PENDING"
            kind = "retry"
            err = (rq[lid] or {}).get("lastError")
        else:
            kind = "unknown"
        p = os.path.join(RES, f"{lid}.json")
        if os.path.isfile(p):
            row = json.load(open(p))
            wall = row.get("wallMs")
            if not st:
                st = row.get("processingState")
            if kind == "retry":
                err = err or row.get("reasonCode")
        rows.append({**r, "finalState": st, "finalKind": kind, "finalError": err, "wallMs": wall})
    return {
        "terminalTotal": len(term),
        "retryTotal": len(rq),
        "rows": rows,
        "terminalized": sum(1 for x in rows if x["finalKind"] == "terminal"),
        "stillRetry": sum(1 for x in rows if x["finalKind"] == "retry"),
    }

false_pub = 0
false_si = 0
false_hot = 0
# lightweight false-positive check: terminal commercial without crawlComplete/policy where required
def check_false(rows):
    fp = fs = fh = 0
    details = []
    for x in rows:
        if x["finalKind"] != "terminal":
            continue
        p = os.path.join(RES, f'{x["leadId"]}.json')
        if not os.path.isfile(p):
            continue
        row = json.load(open(p))
        ev = row.get("fullEvidence") or ""
        ps = row.get("processingState")
        if ps and ps.startswith("PUBLISHED") and row.get("policyFound") is not True and "SELF_INSURANCE" not in (ps or ""):
            # published without policyFound is suspicious unless date stamps only
            if "fonte polizza" not in ev.lower() and "pdf" not in ev.lower():
                fp += 1
                details.append(("PUB", x["leadId"], ps))
        if ps == "SELF_INSURANCE_VERIFIED" and "autoassicur" not in ev.lower() and "gestione diretta" not in ev.lower():
            fs += 1
            details.append(("SI", x["leadId"], ps))
        if ps == "HOT_VERIFIED" and row.get("policyFound") is True:
            fh += 1
            details.append(("HOT", x["leadId"], ps))
    return fp, fs, fh, details

last = None
while time.time() - t0 < timeout_s:
    last = snap()
    # done when all sample left retry or terminal (no in-flight sample)
    cp = json.load(open(CP))
    inp = set((cp.get("inProgress") or {}).keys())
    unfinished = [i for i in ids if i not in (cp.get("terminal") or {})]
    in_flight = [i for i in unfinished if i in inp]
    print(
        json.dumps(
            {
                "elapsedMin": round((time.time() - t0) / 60, 1),
                "terminalized": last["terminalized"],
                "stillRetry": last["stillRetry"],
                "inFlightSample": len(in_flight),
                "termTotal": last["terminalTotal"],
                "retryTotal": last["retryTotal"],
            }
        ),
        flush=True,
    )
    if last["terminalized"] + last["stillRetry"] >= len(ids) and not in_flight:
        # allow settle
        if last["terminalized"] >= 15 or (time.time() - t0) > 600:
            break
    time.sleep(45)

fp, fs, fh, fdet = check_false(last["rows"])
walls = [x["wallMs"] for x in last["rows"] if isinstance(x.get("wallMs"), (int, float))]
walls.sort()
def pct(p):
    if not walls:
        return None
    i = min(len(walls) - 1, int(round((p / 100) * (len(walls) - 1))))
    return walls[i]

elapsed_h = max(1e-6, (time.time() - t0) / 3600)
gained = last["terminalTotal"] - term_before
gate = {
    "finishedAt": datetime.now(timezone.utc).isoformat(),
    "elapsedSec": round(time.time() - t0),
    "sampleSize": len(ids),
    "terminalized": last["terminalized"],
    "externalBlocked": last["stillRetry"],
    "terminalBefore": term_before,
    "terminalAfter": last["terminalTotal"],
    "retryBefore": retry_before,
    "retryAfter": last["retryTotal"],
    "falsePublished": fp,
    "falseSelfInsurance": fs,
    "falseHot": fh,
    "falseDetails": fdet,
    "terminalsPerHour": round(gained / elapsed_h, 2),
    "medianWallMs": pct(50),
    "p95WallMs": pct(95),
    "rows": last["rows"],
    "pass": last["terminalized"] >= 15 and fp == 0 and fs == 0 and fh == 0,
}
json.dump(gate, open(OUT, "w"), ensure_ascii=False, indent=2)
print(json.dumps({k: gate[k] for k in gate if k != "rows"}, indent=2))
print("GATE_PASS" if gate["pass"] else "GATE_FAIL", OUT)
