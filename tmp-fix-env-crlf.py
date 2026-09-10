#!/usr/bin/env python3
from pathlib import Path
p = Path("/home/worker/app/backend/.env")
p.write_bytes(p.read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n"))
print("env_fixed", p.stat().st_size)
