#!/bin/bash
# Esito B: graceful stop, checkpoint backup, deploy fe8b677 worker tree, tests, resume.
set -euo pipefail

CERT_SHA="${CERT_SHA:-fe8b677a2cb4372d6f117c8534d473a51d40913b}"
APP="/opt/leadsniper-revalidate/app"
DATA="/opt/leadsniper-revalidate/data/revalidation"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR="/opt/leadsniper-revalidate/data/stopship-esito-b-${STAMP}"
META="${DATA}/archive-run-meta.json"

echo "=== ESITO B STOP-SHIP ${STAMP} CERT=${CERT_SHA} ==="

mkdir -p "$BACKUP_DIR"

# 1) Graceful stop — workers die with the unit; stale inProgress is reclaimed
#    on resume by production-revalidate-sanita-v3.mjs (IN_PROGRESS_INTERRUPTED → retryQueue).
#    Do NOT rewrite checkpoint here (preserve processed/terminal).
echo "--- stop giorgio-revalidate ---"
systemctl stop giorgio-revalidate || true
sleep 2
# kill any orphan node workers under revalidate tree
pkill -f "/opt/leadsniper-revalidate/app/scripts/production-revalidate" || true
pkill -f "/opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker" || true
sleep 2
systemctl is-active giorgio-revalidate && { echo "FATAL: still active"; exit 1; } || echo "inactive OK"
# Note stuck inProgress count (will be 0 after resume reclaim, not before)
python3 - <<'PY'
import json
d=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
print("pre_resume_inProgress", len(d.get("inProgress") or {}))
print("processed", (d.get("stats") or {}).get("processed"))
PY

# 2) Checkpoint copy + SHA (do NOT wipe processed)
cp -a "${DATA}/checkpoint.json" "${BACKUP_DIR}/checkpoint.json"
sha256sum "${BACKUP_DIR}/checkpoint.json" | tee "${BACKUP_DIR}/checkpoint.sha256"
python3 - <<'PY'
import json
d=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
s=d.get("stats") or {}
print(json.dumps({
  "processed": s.get("processed"),
  "terminal": len(d.get("terminal") or {}),
  "inProgress": len(d.get("inProgress") or {}),
  "retryQueue": len(d.get("retryQueue") or {}),
  "published": s.get("published"),
  "hot": s.get("hot"),
  "review": s.get("review"),
  "retry": s.get("retry"),
  "technical": s.get("technical"),
}, indent=2))
PY

# Backup current (uncertified) worker files for forensics
mkdir -p "${BACKUP_DIR}/uncertified-tree"
for f in \
  scripts/production-revalidate-sanita-v3.mjs \
  scripts/production-revalidate-sanita-worker.mjs \
  scripts/revalidate-checkpoint-v3.mjs \
  src/lib/sanita/canonical-published-terminal.ts \
  src/lib/sanita/crawl-slice-runner.ts \
  src/lib/sanita/scan-engine.ts
do
  if [[ -f "${APP}/${f}" ]]; then
    mkdir -p "${BACKUP_DIR}/uncertified-tree/$(dirname "$f")"
    cp -a "${APP}/${f}" "${BACKUP_DIR}/uncertified-tree/${f}"
    sha256sum "${APP}/${f}" >> "${BACKUP_DIR}/uncertified-hashes.txt"
  fi
done

# 3) Deploy exact fe8b677 files from /tmp/cert-fe8b677 (must be populated by scp first)
SRC="${CERT_TREE:-/tmp/cert-fe8b677}"
if [[ ! -d "$SRC" ]]; then
  echo "FATAL: missing cert tree $SRC"
  exit 1
fi

echo "--- deploy certified files from $SRC ---"
for f in \
  scripts/production-revalidate-sanita-v3.mjs \
  scripts/production-revalidate-sanita-worker.mjs \
  scripts/revalidate-checkpoint-v3.mjs \
  src/lib/sanita/canonical-published-terminal.ts \
  src/lib/sanita/crawl-slice-runner.ts \
  src/lib/sanita/scan-engine.ts
do
  if [[ ! -f "${SRC}/${f}" ]]; then
    echo "FATAL: missing ${SRC}/${f}"
    exit 1
  fi
  mkdir -p "${APP}/$(dirname "$f")"
  cp -a "${SRC}/${f}" "${APP}/${f}"
  sha256sum "${APP}/${f}"
done

# Also deploy test scripts if present in cert tree
for f in scripts/test-published-worker-canonical.mjs scripts/test-revalidation-v3.mjs; do
  if [[ -f "${SRC}/${f}" ]]; then
    cp -a "${SRC}/${f}" "${APP}/${f}"
  fi
done

# 4) Verify hashes match expected
python3 - <<'PY'
import hashlib, json, pathlib, sys
expected = json.load(open("/tmp/cert-fe8b677-expected-hashes.json"))
app = pathlib.Path("/opt/leadsniper-revalidate/app")
ok = True
out = {}
for rel, exp in expected["files"].items():
  p = app / rel
  h = hashlib.sha256(p.read_bytes()).hexdigest()
  match = h == exp["sha256"]
  out[rel] = {"sha256": h, "bytes": p.stat().st_size, "match": match}
  if not match:
    ok = False
    print(f"MISMATCH {rel}: got {h} want {exp['sha256']}")
print(json.dumps({"all_match": ok, "files": out}, indent=2))
sys.exit(0 if ok else 2)
PY

# 5) Run tests in app tree
cd "$APP"
echo "--- test-published-worker-canonical ---"
node scripts/test-published-worker-canonical.mjs
echo "--- test-revalidation-v3 ---"
node scripts/test-revalidation-v3.mjs

# 6) Update run meta — apply live stays disabled; mark engine logical sha
python3 - <<PY
import json, hashlib, pathlib
from datetime import datetime, timezone
meta_path = pathlib.Path("${META}")
meta = {}
if meta_path.exists():
  meta = json.loads(meta_path.read_text())
app = pathlib.Path("${APP}")
files = {}
for rel in [
  "scripts/production-revalidate-sanita-v3.mjs",
  "scripts/production-revalidate-sanita-worker.mjs",
  "scripts/revalidate-checkpoint-v3.mjs",
  "src/lib/sanita/canonical-published-terminal.ts",
  "src/lib/sanita/crawl-slice-runner.ts",
  "src/lib/sanita/scan-engine.ts",
]:
  p = app / rel
  files[rel] = {
    "sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
    "bytes": p.stat().st_size,
  }
meta["ENGINE_LOGICAL_SHA"] = "${CERT_SHA}"
meta["engineFileHashes"] = files
meta["stopshipEsito"] = "B"
meta["stopshipAt"] = datetime.now(timezone.utc).isoformat()
meta["stopshipBackupDir"] = "${BACKUP_DIR}"
meta["applyLiveEnabled"] = False
meta["applyLiveExecuted"] = 0
meta["uncertifiedResultsRequireRevalidation"] = True
meta_path.write_text(json.dumps(meta, indent=2) + "\n")
print("meta updated", meta_path)
PY

# 7) Restart with resume=true (service unit already has resume; do not reset checkpoint)
echo "--- start giorgio-revalidate (resume same checkpoint) ---"
systemctl start giorgio-revalidate
sleep 3
systemctl is-active giorgio-revalidate
python3 - <<'PY'
import json
d=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
s=d.get("stats") or {}
print(json.dumps({
  "processed": s.get("processed"),
  "inProgress": len(d.get("inProgress") or {}),
  "terminal": len(d.get("terminal") or {}),
}, indent=2))
PY

echo "=== ESITO B COMPLETE backup=${BACKUP_DIR} ==="
