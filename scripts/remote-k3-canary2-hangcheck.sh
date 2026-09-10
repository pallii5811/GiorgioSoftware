#!/usr/bin/env bash
set -euo pipefail
WP=$(pgrep -f 'production-revalidate-sanita-worker.mjs' | head -1 || true)
echo "WP=$WP"
if [ -n "${WP:-}" ]; then
  ps -o pid,etime,pcpu,pmem,cmd -p "$WP"
  echo '--- children ---'
  pgrep -P "$WP" -a || true
  # find deepest node worker
  NODE=$(pgrep -f 'tsx /opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker' | tail -1 || true)
  echo "NODE=$NODE"
  if [ -n "${NODE:-}" ]; then
    ps -o pid,etime,pcpu,pmem,cmd -p "$NODE"
    echo '--- node children ---'
    pstree -p "$NODE" 2>/dev/null | head -40 || ps --forest -g $(ps -o sid= -p "$NODE") -o pid,etime,pcpu,cmd 2>/dev/null | head -40
  fi
fi
echo '=== browsers ==='
pgrep -af 'chrom|playwright|pdftoppm|tesseract' | head -30 || true
echo '=== inProgress ==='
python3 - <<'PY'
import json
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
print(json.dumps(cp.get('inProgress'), indent=1)[:2000])
PY
echo '=== frontier magnolie nodes sample ==='
FP=/opt/leadsniper-revalidate/data/revalidation/frontiers/reval-p1-cmqkld5s0009u108eghihpoxi-1784585270080.sqlite
python3 - <<PY
import sqlite3, os
fp="$FP"
print('exists', os.path.exists(fp), 'size', os.path.getsize(fp) if os.path.exists(fp) else None)
if os.path.exists(fp):
  con=sqlite3.connect(fp)
  try:
    print('nodes', con.execute('select state, count(*) from CrawlNode group by state').fetchall())
    print('docs', con.execute('select count(*) from DocumentEvidence').fetchone())
  except Exception as e:
    print('err', e)
PY
