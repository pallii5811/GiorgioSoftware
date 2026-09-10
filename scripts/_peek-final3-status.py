#!/usr/bin/env python3
import json, subprocess
from pathlib import Path

cp = json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
ids = "cmqktyimz000i111hygme29nh,cmqklex5q00bh108eq9blm01k,cmqoe7vww004aaa3v67rkgl4e".split(",")
print("inProgress", list(cp.get("inProgress", {}).keys()))
for i in ids:
    t = cp.get("terminal", {}).get(i)
    r = cp.get("retryQueue", {}).get(i)
    print(
        i[:12],
        "T" if t else "-",
        (t or {}).get("processingState"),
        "R" if r else "-",
        (r or {}).get("lastReason"),
        (r or {}).get("lastError"),
    )
p = Path("/opt/leadsniper-revalidate/data/k3-stopship/FINAL_THREE_RESULTS.json")
print("FINAL_THREE exists", p.exists(), "size", p.stat().st_size if p.exists() else 0)
print("---LOG---")
log = Path("/tmp/k3-final-three.log")
if log.exists():
    print("\n".join(log.read_text(errors="replace").splitlines()[-40:]))
