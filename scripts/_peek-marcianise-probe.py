#!/usr/bin/env python3
import json, os
from pathlib import Path
p = Path("/opt/leadsniper-revalidate/data/k3-stopship/MARCIANISE_ASL_PROBE.json")
print("exists", p.exists(), "size", p.stat().st_size if p.exists() else 0)
if p.exists():
    d = json.loads(p.read_text())
    print("keys", list(d.keys()))
    for k in ("summary", "n_pages", "n_pdfs", "hits", "pdf_hits", "relevant_pdfs"):
        if k in d:
            print(k, json.dumps(d[k], ensure_ascii=False)[:800])
