#!/usr/bin/env python3
import json, re
from pathlib import Path
d = json.loads(Path("/opt/leadsniper-revalidate/data/k3-stopship/PINI_DEEP.json").read_text())
print("rec", d["recommendation"])
print("pages_ok", sum(1 for p in d["pages"] if p.get("ok")), "fail", sum(1 for p in d["pages"] if not p.get("ok")))
for p in d["pages"]:
    if p.get("ok") and (p.get("has_assicur") or p.get("has_parm")):
        print("HIT", p["url"][:90], "assicur", p.get("has_assicur"), "parm", p.get("has_parm"))
for a in d["pdfs"]:
    print("PDF", a.get("url","")[-60:], "chars", a.get("chars"), "si", a.get("self_insurance"), "pol", a.get("policy"), "err", a.get("error"))
    print("  snip", (a.get("snippet") or "")[:200])

# existing result
rp = Path("/opt/leadsniper-revalidate/data/revalidation/results/cmqklex5q00bh108eq9blm01k.json")
row = json.loads(rp.read_text())
ev = row.get("fullEvidence") or ""
print("STATE", row.get("processingState"), row.get("policyCompany"))
print("EV_HEAD", ev[:400].replace("\n"," "))
print("TAGS", re.findall(r"\[(?:PS|STATE|BV|FRONTIER):[^\]]+\]", ev)[:8])
