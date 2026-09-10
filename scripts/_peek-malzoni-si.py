#!/usr/bin/env python3
import json, time
from pathlib import Path

MID = "cmqktyimz000i111hygme29nh"
cp = json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
t = cp.get("terminal", {}).get(MID)
r = cp.get("retryQueue", {}).get(MID)
ip = cp.get("inProgress", {}).get(MID)
row = {}
rp = Path(f"/opt/leadsniper-revalidate/data/revalidation/results/{MID}.json")
if rp.exists():
    row = json.loads(rp.read_text())
log = Path("/tmp/k3-self-insurance-malzoni.log")
tail = "\n".join(log.read_text(errors="replace").splitlines()[-25:]) if log.exists() else ""
print(json.dumps({
    "inProgress": bool(ip),
    "terminal": (t or {}).get("processingState"),
    "retry": (r or {}).get("lastReason"),
    "resultState": row.get("processingState"),
    "bv": row.get("businessVerdict"),
    "company": row.get("policyCompany"),
    "wallMs": row.get("wallMs"),
    "finishedAt": row.get("finishedAt"),
    "evidenceHead": (row.get("fullEvidence") or "")[:280],
}, ensure_ascii=False, indent=2))
print("---LOG---")
print(tail)
