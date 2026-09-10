#!/usr/bin/env bash
# FASE 1: graceful stop + snapshot (never delete live data / checkpoint)
set -uo pipefail
TS=$(date -u +%Y%m%dT%H%M%SZ)
SNAP=/opt/leadsniper-revalidate/snapshots/recovery-$TS
WORKDIR=/opt/leadsniper-revalidate
mkdir -p "$SNAP"

echo "=== STOP ==="
systemctl stop giorgio-revalidate || true
# wait up to 20 min for graceful exit of current lead
for i in $(seq 1 240); do
  if ! pgrep -f 'production-revalidate-sanita' >/dev/null 2>&1; then
    break
  fi
  sleep 5
done
# only if still hung after wait
if pgrep -f 'production-revalidate-sanita' >/dev/null 2>&1; then
  echo "WARN still running after wait — SIGTERM again"
  pkill -TERM -f 'production-revalidate-sanita' || true
  sleep 30
fi
# orphans: chrome/ocr not owned by reval (reval should be gone)
pkill -TERM -f 'chrome-headless-shell' 2>/dev/null || true
sleep 5

echo "=== STATE ==="
python3 - <<'PY'
import json, os, hashlib, pathlib
cp_path="/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"
res_dir="/opt/leadsniper-revalidate/data/revalidation/results"
shadow="/opt/leadsniper-revalidate/shadow-revalidate.db"
cp=json.load(open(cp_path))
done=len(cp.get("done") or {})
term=len(cp.get("terminal") or {})
retry=len(cp.get("retryQueue") or {})
results=len([f for f in os.listdir(res_dir) if f.endswith(".json")]) if os.path.isdir(res_dir) else 0
print(json.dumps({
  "version": cp.get("version"),
  "done": done,
  "terminal": term,
  "retryQueue": retry,
  "stats": cp.get("stats"),
  "results": results,
  "sha": cp.get("testedCodeSha"),
  "shadow_exists": os.path.exists(shadow),
  "shadow_bytes": os.path.getsize(shadow) if os.path.exists(shadow) else 0,
}, indent=2))
# integrity via python sqlite
import sqlite3
con=sqlite3.connect(f"file:{shadow}?mode=ro", uri=True)
print("shadow_integrity", con.execute("PRAGMA integrity_check").fetchone()[0])
print("shadow_leads", con.execute("select count(*) from Lead").fetchone()[0])
con.close()
PY

echo "=== SNAPSHOT $SNAP ==="
cp -a "$WORKDIR/data/revalidation/checkpoint.json" "$SNAP/checkpoint.json"
cp -a "$WORKDIR/shadow-revalidate.db" "$SNAP/shadow-revalidate.db"
mkdir -p "$SNAP/results" "$SNAP/frontiers" "$SNAP/logs"
cp -a "$WORKDIR/data/revalidation/results/." "$SNAP/results/" 2>/dev/null || true
# frontiers can be large — copy metadata + recent; full copy of sqlite files without huge WAL if possible
rsync -a --exclude='*.wal' "$WORKDIR/data/revalidation/frontiers/" "$SNAP/frontiers/" 2>/dev/null || true
cp -a /etc/systemd/system/giorgio-revalidate.service "$SNAP/giorgio-revalidate.service" 2>/dev/null || true
cp -a "$WORKDIR/app/RELEASE_SHA" "$SNAP/RELEASE_SHA" 2>/dev/null || true
tail -n 500 "$WORKDIR/logs/systemd-revalidate.log" > "$SNAP/systemd-revalidate.tail.log" 2>/dev/null || true
# hash manifest
python3 - <<PY
import hashlib, json, os, pathlib
snap=pathlib.Path("$SNAP")
manifest={}
for p in snap.rglob("*"):
  if p.is_file() and p.stat().st_size < 80_000_000:
    h=hashlib.sha256(p.read_bytes()).hexdigest()
    manifest[str(p.relative_to(snap))]= {"sha256": h, "bytes": p.stat().st_size}
(snap/"MANIFEST.json").write_text(json.dumps(manifest, indent=2))
# reopen shadow read-only
import sqlite3
db=snap/"shadow-revalidate.db"
con=sqlite3.connect(f"file:{db}?mode=ro", uri=True)
ok=con.execute("PRAGMA integrity_check").fetchone()[0]
n=con.execute("select count(*) from Lead").fetchone()[0]
con.close()
meta={"ts":"$TS","integrity":ok,"leads":n,"files":len(manifest)}
(snap/"SNAPSHOT_META.json").write_text(json.dumps(meta, indent=2))
print(json.dumps(meta, indent=2))
PY

pgrep -af 'production-revalidate|chrome-headless' || echo "CLEAN"
echo "SNAP_OK $SNAP"
