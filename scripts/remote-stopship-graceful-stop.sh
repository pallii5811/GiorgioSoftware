#!/usr/bin/env bash
set -euo pipefail
CP=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json
OUT=/tmp/stopship-forensic
mkdir -p "$OUT"

echo "=== PRE STOP ==="
systemctl is-active giorgio-revalidate || true
MAINPID=$(systemctl show giorgio-revalidate -p MainPID --value)
echo "MainPID=$MAINPID"
sha256sum "$CP" | tee "$OUT/cp-before.sha"
stat -c '%y %s' "$CP" | tee "$OUT/cp-before.stat"

python3 - <<'PY'
import json, os
cp_path="/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"
c=json.load(open(cp_path))
t=c.get("terminal") or {}
def ps(v):
    if isinstance(v,str): return v.upper()
    return str((v or {}).get("processingState") or (v or {}).get("state") or "").upper()
tech=[(k,v) for k,v in t.items() if ps(v)=="TECHNICAL_BLOCKED"]
print("processed", (c.get("stats") or {}).get("processed"))
print("terminal", len(t))
print("tech", len(tech))
print("inProgress", len(c.get("inProgress") or {}))
print("retry", len(c.get("retryQueue") or {}))
print("hot", sum(1 for v in t.values() if ps(v)=="HOT_VERIFIED"))
print("pub", sum(1 for v in t.values() if ps(v).startswith("PUBLISHED")))
print("review", sum(1 for v in t.values() if ps(v)=="REVIEW_HUMAN"))
open("/tmp/stopship-forensic/tech-ids.txt","w").write("\n".join(k for k,_ in tech)+"\n")
open("/tmp/stopship-forensic/tech-raw.json","w").write(json.dumps({k:v for k,v in tech}, indent=2, ensure_ascii=False))
print("TECH_IDS_WRITTEN", len(tech))
PY

# Graceful stop
echo "=== SIGTERM ==="
systemctl kill -s SIGTERM giorgio-revalidate || systemctl stop giorgio-revalidate
for i in $(seq 1 60); do
  st=$(systemctl is-active giorgio-revalidate || true)
  ip=$(python3 -c "import json; c=json.load(open('$CP')); print(len(c.get('inProgress') or {}))")
  echo "t=${i}s active=$st inProgress=$ip"
  if [ "$st" != "active" ] && [ "$ip" = "0" ]; then
    break
  fi
  # if inactive but inProgress leftover, clear is NOT allowed — wait more then report
  if [ "$st" != "active" ]; then
    sleep 2
    ip=$(python3 -c "import json; c=json.load(open('$CP')); print(len(c.get('inProgress') or {}))")
    echo "post-inactive inProgress=$ip"
    break
  fi
  sleep 2
done

systemctl is-active giorgio-revalidate || true
sha256sum "$CP" | tee "$OUT/cp-after-stop.sha"
python3 - <<'PY'
import json
c=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
print(json.dumps({
  "processed": (c.get("stats") or {}).get("processed"),
  "terminal": len(c.get("terminal") or {}),
  "inProgress": len(c.get("inProgress") or {}),
  "retry": len(c.get("retryQueue") or {}),
  "updatedAt": c.get("updatedAt"),
}, indent=2))
PY
# backup checkpoint
cp -a "$CP" "$OUT/checkpoint-after-stop.json"
echo STOP_OK
