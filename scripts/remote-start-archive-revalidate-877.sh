#!/bin/bash
# Start 877 archive revalidation (shadow) with safety gates. Does NOT wipe baseline.
set -euo pipefail

BASELINE_DIR=/opt/leadsniper/backups/published-legacy-baseline-20260721T155725Z
BASELINE_JSON=$BASELINE_DIR/published-legacy-baseline.json
EXPECT_JSON_SHA=5e93be5d8dd71384f9773138b5b1392c40f5550535266f39671e11af60d22894
APP=/opt/leadsniper-revalidate
LOCK_DIR=$APP/data/revalidation/locks
CP=$APP/data/revalidation/checkpoint.json
JOURNAL_DIR=$APP/data/revalidation/legacy-compare-journal
RUN_META=$APP/data/revalidation/archive-run-meta.json

echo "=== PREFLIGHT ==="
test "$(systemctl is-active giorgio-revalidate || true)" != "active" || {
  echo "REFUSING: already active"; exit 2
}
test -f "$BASELINE_JSON"
GOT=$(sha256sum "$BASELINE_JSON" | awk '{print $1}')
test "$GOT" = "$EXPECT_JSON_SHA" || { echo "BASELINE_TAMPERED $GOT"; exit 2; }
echo "BASELINE_OK $GOT"

# no active UI jobs
python3 - <<'PY'
import json, urllib.request, sys
raw=urllib.request.urlopen('http://127.0.0.1:3000/api/sanita/jobs?active=1', timeout=20).read()
j=json.loads(raw)
jobs=j.get('jobs') or []
if jobs:
  print('REFUSING_ACTIVE_UI_JOBS', json.dumps(jobs, indent=2))
  sys.exit(2)
print('UI_ACTIVE_JOBS=0')
PY

# reclaim dead locks
python3 - <<'PY'
import os, json
lock_dir="/opt/leadsniper-revalidate/data/revalidation/locks"
n=0
for name in os.listdir(lock_dir) if os.path.isdir(lock_dir) else []:
  if not name.endswith('.lock'): continue
  p=os.path.join(lock_dir,name)
  try:
    pid=int(open(p).read().strip())
  except Exception:
    os.unlink(p); n+=1; continue
  try:
    os.kill(pid,0)
  except ProcessLookupError:
    os.unlink(p); n+=1
  except PermissionError:
    pass
print(json.dumps({"stale_locks_reclaimed": n}))
PY

mkdir -p "$JOURNAL_DIR"
# freeze baseline pointer into journal (never rewrite baseline dir)
cp -a "$BASELINE_DIR/MANIFEST.json" "$JOURNAL_DIR/baseline-MANIFEST.frozen.json"
cp -a "$BASELINE_DIR/SHA256SUMS" "$JOURNAL_DIR/baseline-SHA256SUMS.frozen"

python3 - <<'PY'
import json, time, hashlib, os
meta={
  "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
  "engine": "giorgio-revalidate",
  "corpus": "shadow-revalidate.db",
  "targetTotal": 877,
  "resume": True,
  "baselinePath": "/opt/leadsniper/backups/published-legacy-baseline-20260721T155725Z",
  "baselineJsonSha256": "5e93be5d8dd71384f9773138b5b1392c40f5550535266f39671e11af60d22894",
  "blueReleaseSha": open("/opt/leadsniper/RELEASE_SHA").read().strip(),
  "revalidateAppSha": open("/opt/leadsniper-revalidate/app/RELEASE_SHA").read().strip() if os.path.isfile("/opt/leadsniper-revalidate/app/RELEASE_SHA") else None,
  "checkpointPath": "/opt/leadsniper-revalidate/data/revalidation/checkpoint.json",
  "note": "UI lacks Rivalida archivio button on 3f58735 — started authorized 877 shadow revalidate engine.",
}
open("/opt/leadsniper-revalidate/data/revalidation/archive-run-meta.json","w").write(json.dumps(meta,indent=2))
print(json.dumps(meta,indent=2))
PY

# snapshot checkpoint hash before start
sha256sum "$CP" | tee "$JOURNAL_DIR/checkpoint-before.sha256"

systemctl start giorgio-revalidate
sleep 5
echo "REVAL=$(systemctl is-active giorgio-revalidate)"
# show first metrics
tail -5 /opt/leadsniper-revalidate/logs/systemd-revalidate.log || true
python3 - <<'PY'
import json
d=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
print(json.dumps({
  'status': 'started',
  'stats': d.get('stats'),
  'terminal': len(d.get('terminal') or {}),
  'retryQueue': len(d.get('retryQueue') or {}),
  'inProgress': len(d.get('inProgress') or {}),
}, indent=2))
PY
echo ARCHIVE_REVALIDATE_STARTED
