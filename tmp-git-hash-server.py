import hashlib
from pathlib import Path

def git_hash(p: str) -> str:
    data = Path(p).read_bytes()
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()

root = Path("/opt/leadsniper")
for f in [
    "scripts/production-revalidate-sanita-v3.mjs",
    "scripts/production-revalidate-sanita-worker.mjs",
    "src/lib/sanita/self-insurance.ts",
    "src/components/sanita-leads.tsx",
    "src/lib/sanita/scan-engine-url.ts",
    "scripts/test-regression-corpus.mjs",
]:
    p = root / f
    print(f, "EXISTS" if p.exists() else "MISSING", git_hash(str(p)) if p.exists() else "-")
print("RELEASE", (root / "RELEASE_SHA").read_text().strip())
