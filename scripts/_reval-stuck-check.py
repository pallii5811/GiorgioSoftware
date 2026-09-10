#!/usr/bin/env python3
import json, os, subprocess, time
from pathlib import Path

cp = json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
inp = cp.get("inProgress") or {}
print("inProgress detail:")
print(json.dumps(inp, indent=2)[:3000])

print("\n--- processes ---")
print(subprocess.getoutput("ps aux | grep -E 'production-revalidate|tsx' | grep -v grep | head -20"))

print("\n--- locks ---")
ld = Path("/opt/leadsniper-revalidate/data/revalidation/locks")
if ld.is_dir():
    for p in sorted(ld.iterdir())[:20]:
        print(p.name, p.stat().st_mtime, time.ctime(p.stat().st_mtime))

print("\n--- journal recent ---")
print(subprocess.getoutput("journalctl -u giorgio-revalidate -n 30 --no-pager 2>/dev/null | tail -30"))
