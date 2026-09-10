#!/usr/bin/env python3
from pathlib import Path
src = Path("/tmp/tmp-angela-force2.sh")
dst = Path("/tmp/angela-force2.sh")
if not src.exists():
    src = dst
data = src.read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n")
dst.write_bytes(data)
dst.chmod(0o755)
print("OK", dst, len(data))
