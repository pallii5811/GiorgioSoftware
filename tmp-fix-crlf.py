#!/usr/bin/env python3
from pathlib import Path
p = Path("/tmp/angela-force2.sh")
p.write_bytes(p.read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n"))
print("CRLF_FIXED", p.stat().st_size)
