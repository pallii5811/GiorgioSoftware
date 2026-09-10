#!/usr/bin/env python3
from pathlib import Path
import sys
for p in map(Path, sys.argv[1:]):
    if not p.exists():
        continue
    p.write_bytes(p.read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n"))
    p.chmod(0o755)
    print("normalized", p)
