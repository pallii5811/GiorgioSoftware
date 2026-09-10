#!/usr/bin/env python3
import json, re
from pathlib import Path

MID = "cmqktyimz000i111hygme29nh"
SAMPLE = "cmqkld5rk009b108ekvol7g87,cmql4qrif000yc9w74e0tmpqt,cmql4d399000uc9w7yzw2dgac,cmqktyimz000i111hygme29nh,cmqklex5q00bh108eq9blm01k,cmql4d38u000kc9w7ng9zvakw,cmqkld5rt009m108ejllpw8nz,cmqmaor4t00389g5c2iuoauuw,cmqp7cqya00011q5bkqf3ox8q,cmqoe7vww004aaa3v67rkgl4e".split(",")
COMM = {
    "PUBLISHED_CURRENT",
    "PUBLISHED_EXPIRED",
    "PUBLISHED_DATE_UNKNOWN",
    "SELF_INSURANCE_VERIFIED",
    "HOT_VERIFIED",
}
cp = json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
rd = Path("/opt/leadsniper-revalidate/data/revalidation/results")
rows = []
for i in SAMPLE:
    t = cp.get("terminal", {}).get(i) or {}
    r = cp.get("retryQueue", {}).get(i) or {}
    row = json.loads((rd / f"{i}.json").read_text()) if (rd / f"{i}.json").exists() else {}
    st = t.get("processingState") or r.get("lastReason") or row.get("processingState")
    rows.append({
        "id": i,
        "name": (row.get("companyName") or "")[:40],
        "state": st,
        "commercial": st in COMM,
        "company": row.get("policyCompany"),
    })
    print(f"{i[:12]}\t{st}\t{row.get('companyName','')[:35]}")

mal = json.loads((rd / f"{MID}.json").read_text())
ev = mal.get("fullEvidence") or ""
print("--- MALZONI EVIDENCE TAGS ---")
print(re.findall(r"\[(?:PS|STATE|BV|SELF_INSURANCE_CITATION):[^\]]+\]", ev)[:12])
print("autoassicur" in ev.lower(), "regime" in ev.lower())
cites = re.findall(r"SELF_INSURANCE_CITATION:([^\]]+)", ev)
print("citation", cites[:1])
pdfs = re.findall(r"https?://\S+\.pdf", ev)
print("pdfs", pdfs[:5])

comm_n = sum(1 for r in rows if r["commercial"])
reachable = [r for r in rows if r["state"] not in (None, "NOWEB") and "NOWEB" not in str(r["state"] or "")]
# Marcianise REVIEW still counts as reachable if website set
print(json.dumps({
    "completedCommercial": comm_n,
    "rawPct": round(100 * comm_n / 10, 1),
    "malzoni": next(r for r in rows if r["id"] == MID),
    "byState": {r["id"][:8]: r["state"] for r in rows},
}, ensure_ascii=False, indent=2))

out = Path("/opt/leadsniper-revalidate/data/k3-stopship/SELF_INSURANCE_MALZONI_PROOF.json")
out.write_text(json.dumps({
    "malzoni": {
        "id": MID,
        "processingState": mal.get("processingState"),
        "businessVerdict": mal.get("businessVerdict"),
        "policyCompany": mal.get("policyCompany"),
        "finishedAt": mal.get("finishedAt"),
        "wallMs": mal.get("wallMs"),
        "citation": cites[:1],
        "pdfs": pdfs[:6],
    },
    "sample10": rows,
    "completedCommercial": comm_n,
}, ensure_ascii=False, indent=2))
print("wrote", out)
