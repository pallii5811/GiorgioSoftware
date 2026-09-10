#!/usr/bin/env python3
"""Document Marcianise REVIEW reason + Pini SI proof."""
import json, re
from pathlib import Path
RD = Path("/opt/leadsniper-revalidate/data/revalidation/results")
for i, name in [
    ("cmqklex5q00bh108eq9blm01k", "Pini"),
    ("cmqoe7vww004aaa3v67rkgl4e", "Marcianise"),
    ("cmqktyimz000i111hygme29nh", "Malzoni"),
]:
    r = json.loads((RD / f"{i}.json").read_text())
    ev = r.get("fullEvidence") or ""
    print("===", name, r.get("processingState"), r.get("businessVerdict"), r.get("policyCompany"))
    print("web", r.get("website"), "reach", r.get("websiteReachable"), "reason", r.get("reasonCode"))
    print("tags", re.findall(r"\[(?:PS|STATE|BV|FRONTIER|SELF_INSURANCE_CITATION):[^\]]{0,120}\]", ev)[:6])
    print("head", ev[:220].replace("\n", " "))
    print()
