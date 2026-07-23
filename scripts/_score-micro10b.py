#!/usr/bin/env python3
import json
from pathlib import Path

cp = json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
ids = "cmqkld5rk009b108ekvol7g87,cmql4qrif000yc9w74e0tmpqt,cmql4d399000uc9w7yzw2dgac,cmqktyimz000i111hygme29nh,cmqklex5q00bh108eq9blm01k,cmql4d38u000kc9w7ng9zvakw,cmqkld5rt009m108ejllpw8nz,cmqmaor4t00389g5c2iuoauuw,cmqp7cqya00011q5bkqf3ox8q,cmqoe7vww004aaa3v67rkgl4e".split(",")
rd = Path("/opt/leadsniper-revalidate/data/revalidation/results")
strict = {"PUBLISHED_CURRENT", "PUBLISHED_EXPIRED", "PUBLISHED_DATE_UNKNOWN", "HOT_VERIFIED"}
comm = strict | {"PUBLISHED_ANALOGOUS_MEASURE"}

print("id\tstate\treason\tpolicy\twall\tcompany")
for i in ids:
    t = cp.get("terminal", {}).get(i)
    r = cp.get("retryQueue", {}).get(i)
    row = {}
    p = rd / f"{i}.json"
    if p.exists():
        try:
            row = json.load(open(p))
        except Exception:
            pass
    st = (t or {}).get("processingState") or (r or {}).get("lastReason") or row.get("processingState")
    reason = (r or {}).get("lastError") or (t or {}).get("reasonCode") or row.get("reasonCode")
    name = (row.get("companyName") or "")[:45]
    print(f"{i}\t{st}\t{reason}\t{row.get('policyFound')}\t{row.get('wallMs')}\t{name}")

term = [i for i in ids if i in cp.get("terminal", {})]
print("strict", sum(1 for i in term if cp["terminal"][i]["processingState"] in strict))
print("withAnalogous", sum(1 for i in term if cp["terminal"][i]["processingState"] in comm))
print("retry_ids", [i for i in ids if i in cp.get("retryQueue", {})])
for i in ids:
    if i not in cp.get("retryQueue", {}):
        continue
    row = json.load(open(rd / f"{i}.json")) if (rd / f"{i}.json").exists() else {}
    ev = (row.get("fullEvidence") or "")[-400:]
    print("RETRY_DETAIL", i, row.get("companyName"), row.get("reasonCode"), row.get("website"))
    print("  tail:", ev.replace("\n", " ")[:350])

res = json.load(open("/opt/leadsniper-revalidate/data/k3-stopship/MICRO_CANARY10_RESULTS.json"))
print("gate", res.get("gate"))
print("byState", res.get("byState"))
