#!/usr/bin/env python3
import json, hashlib
from pathlib import Path
d = Path("/opt/leadsniper/backups/published-legacy-baseline-20260721T155725Z")
p = d / "published-legacy-baseline.json"
raw = p.read_bytes()
obj = json.loads(raw)
print("type", type(obj).__name__)
if isinstance(obj, dict):
    print("keys", list(obj.keys())[:20])
    for k in ("leads", "items", "published", "count", "rows"):
        if k in obj:
            v = obj[k]
            print(k, type(v).__name__, len(v) if hasattr(v, "__len__") else v)
elif isinstance(obj, list):
    print("len", len(obj))
print("sha", hashlib.sha256(raw).hexdigest())
print("sums", (d / "SHA256SUMS").read_text()[:500])
