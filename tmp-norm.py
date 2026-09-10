#!/usr/bin/env python3
from pathlib import Path
for src_name, dst_name in [
    ("tmp-final-output.sh", "final-output.sh"),
    ("tmp-verify-contacts.sh", "verify-contacts.sh"),
    ("tmp-vercel-check.sh", "vercel-check.sh"),
]:
    src = Path("/tmp") / src_name
    if not src.exists():
        src = Path("/tmp") / dst_name
    if not src.exists():
        continue
    data = src.read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    dst = Path("/tmp") / dst_name
    dst.write_bytes(data)
    dst.chmod(0o755)
    print("normalized", dst)
