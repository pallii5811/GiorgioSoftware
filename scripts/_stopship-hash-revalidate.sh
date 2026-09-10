#!/usr/bin/env bash
# Stop-ship: hash critical revalidate files and grep for banned patterns.
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
cd "$APP"
FILES=(
  scripts/production-revalidate-sanita-v3.mjs
  scripts/production-revalidate-sanita-worker.mjs
  scripts/revalidate-checkpoint-v3.mjs
  src/lib/sanita/canonical-published-terminal.ts
  src/lib/sanita/crawl-slice-runner.ts
  src/lib/sanita/scan-engine.ts
)
echo "=== RUNNING_TREE ==="
echo "PWD=$(pwd)"
echo "RELEASE_SHA=$(cat RELEASE_SHA 2>/dev/null || true)"
echo "REVAL=$(systemctl is-active giorgio-revalidate || true)"
echo "=== HASHES ==="
python3 - <<'PY'
import hashlib, json, os, re
app="/opt/leadsniper-revalidate/app"
files=[
  "scripts/production-revalidate-sanita-v3.mjs",
  "scripts/production-revalidate-sanita-worker.mjs",
  "scripts/revalidate-checkpoint-v3.mjs",
  "src/lib/sanita/canonical-published-terminal.ts",
  "src/lib/sanita/crawl-slice-runner.ts",
  "src/lib/sanita/scan-engine.ts",
]
out={"files":{}, "grep":{}}
for rel in files:
  p=os.path.join(app, rel)
  if not os.path.isfile(p):
    out["files"][rel]={"exists": False}
    continue
  raw=open(p,"rb").read()
  out["files"][rel]={
    "exists": True,
    "bytes": len(raw),
    "sha256": hashlib.sha256(raw).hexdigest(),
  }
worker=open(os.path.join(app,"scripts/production-revalidate-sanita-worker.mjs"),"r",encoding="utf-8",errors="replace").read()
out["grep"]["imports_acceptCanonicalPublishedTerminal"]=bool(re.search(r"acceptCanonicalPublishedTerminal", worker))
out["grep"]["has_scadut_regex"]=bool(re.search(r"scadut", worker, re.I))
out["grep"]["has_policyObsolete_docs_promo"]=bool(re.search(r"policyObsolete[\s\S]{0,120}\[DOCS", worker, re.I)) or bool(re.search(r"PUBLISHED_EXPIRED[\s\S]{0,80}DOCS", worker, re.I))
out["grep"]["has_hot_to_published_promo"]=bool(re.search(r"HOT[\s\S]{0,80}PUBLISHED|promote.*PUBLISHED.*HOT", worker, re.I))
# show relevant lines
hits=[]
for i,line in enumerate(worker.splitlines(),1):
  if re.search(r"acceptCanonicalPublishedTerminal|scadut|policyObsolete|PUBLISHED_EXPIRED|REVIEW.*PUBLISHED|HOT.*PUBLISHED", line, re.I):
    hits.append({"line": i, "text": line.strip()[:200]})
out["grep"]["hit_lines"]=hits[:40]
print(json.dumps(out, indent=2))
PY
