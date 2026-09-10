#!/bin/bash
# Canary 3-lead — NEVER full 877. Leaves production paused + enabled.
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
UI=/opt/leadsniper
CP=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json
DB=/opt/leadsniper/prisma/dev.db
export PATH="/snap/bin:$PATH"

SHA_BEFORE=$(sha256sum "$DB" | awk '{print $1}')
HC_BEFORE=$(python3 -c "import sqlite3;print(sqlite3.connect('$DB').execute(\"select count(*) from Lead where type='HEALTHCARE'\").fetchone()[0])")
test "$HC_BEFORE" = "877"
echo "SHA_BEFORE=$SHA_BEFORE HC=$HC_BEFORE"

python3 - <<'PY' > /tmp/canary3.ids
import sqlite3
c=sqlite3.connect('/opt/leadsniper/prisma/dev.db')
ids=[]
for q in ["%Villa Dei Pini%","%Malzoni Villa Platani%"]:
  r=c.execute("select id from Lead where companyName like ? limit 1",(q,)).fetchone()
  if r: ids.append(r[0])
placeholders=",".join("?"*len(ids)) if ids else "''"
params=list(ids)
r=c.execute(f"select id from Lead where type='HEALTHCARE' and evidence like '[V:HOT]%' and id not in ({placeholders}) limit 1", params).fetchone()
if r: ids.append(r[0])
assert len(ids)==3, ids
print(",".join(ids))
PY
IDS=$(cat /tmp/canary3.ids)
echo "CANARY_IDS=$IDS"

systemctl stop giorgio-revalidate 2>/dev/null || true
pkill -f 'production-revalidate-sanita-v3.mjs' 2>/dev/null || true
sleep 2

# Preserve empty-ish canary checkpoint (do not wipe production frontiers forever — reset terminal only for canary ids)
python3 - <<PY
import json
from datetime import datetime, timezone
from pathlib import Path
cp={
  "version":3,
  "testedCodeSha": Path("/opt/leadsniper/RELEASE_SHA").read_text().strip(),
  "terminal":{},
  "retryQueue":{},
  "inProgress":{},
  "attempts":{},
  "stats":{"processed":0,"terminal":0,"hot":0,"pub":0,"review":0,"retry":0,"tech":0,"outOfScope":0,"errors":0},
  "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00","Z"),
}
Path("$CP").write_text(json.dumps(cp,indent=2),encoding="utf-8")
print("CP_RESET_FOR_CANARY")
PY

mkdir -p /etc/systemd/system/giorgio-revalidate.service.d
cat >/etc/systemd/system/giorgio-revalidate.service.d/canary.conf <<EOF
[Service]
Environment=REVALIDATE_IDS=$IDS
Environment=APPLY_LIVE=0
Environment=DISABLE_LIVE_DB=true
Environment=PER_HOST_CONCURRENCY=1
Environment=TOTAL_WORKERS=1
Environment=REVALIDATE_CONCURRENCY=1
EOF
systemctl daemon-reload

# 1) one start
systemctl reset-failed giorgio-revalidate || true
systemctl start giorgio-revalidate
sleep 4
ACTIVE1=$(systemctl is-active giorgio-revalidate || true)
echo "ACTIVE_AFTER_START=$ACTIVE1"
test "$ACTIVE1" = "active"

# 2) second start must not duplicate parent (flock)
systemctl start giorgio-revalidate || true
sleep 2
PARENTS=$(pgrep -af 'production-revalidate-sanita-v3.mjs' | grep -v 'production-revalidate-sanita-worker' | grep -vc pgrep || true)
echo "PARENT_LINES=$PARENTS"
FLOCK_HOLDERS=$(lsof /opt/leadsniper-revalidate/revalidate.parent.lock 2>/dev/null | wc -l || true)
echo "FLOCK_LINES=$FLOCK_HOLDERS"

# 3) browser close sim (UI job file gone) — engine must stay
rm -f /opt/leadsniper/data/sanita-revalidation-job.json 2>/dev/null || true
sleep 2
ACTIVE_BC=$(systemctl is-active giorgio-revalidate || true)
echo "ACTIVE_AFTER_BROWSER_CLOSE_SIM=$ACTIVE_BC"
test "$ACTIVE_BC" = "active"

# 4) wait up to 25 min for >=1 TERMINAL (Nuovi risultati = scope=run = terminal only)
DEADLINE=$((SECONDS+1500))
GOT=0
while (( SECONDS < DEADLINE )); do
  python3 - <<'PY'
import json
from pathlib import Path
cp=json.loads(Path('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json').read_text())
term=len(cp.get('terminal') or {})
res=len(list(Path('/opt/leadsniper-revalidate/data/revalidation/results').glob('*.json')))
ip=len(cp.get('inProgress') or {})
print(term, res, ip)
open('/tmp/canary_prog','w').write(f"{term} {res} {ip}")
PY
  read TERM RES IP </tmp/canary_prog || true
  echo "progress terminal=$TERM results=$RES inProgress=$IP active=$(systemctl is-active giorgio-revalidate || true)"
  if [[ "${TERM:-0}" -ge 1 ]]; then GOT=1; break; fi
  if [[ "$(systemctl is-active giorgio-revalidate || true)" != "active" ]]; then
    systemctl reset-failed giorgio-revalidate || true
    systemctl start giorgio-revalidate || true
  fi
  sleep 30
done
echo "GOT_RESULT=$GOT"

# 5) pause + resume conserves frontier/terminal
CP_BEFORE_PAUSE=$(sha256sum "$CP" | awk '{print $1}')
systemctl stop giorgio-revalidate
sleep 2
python3 - <<'PY'
import json,shutil
from pathlib import Path
cp=json.loads(Path('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json').read_text())
print('terminal_before_resume', len(cp.get('terminal') or {}))
print('inProgress_before_resume', len(cp.get('inProgress') or {}))
Path('/tmp/cp-before-resume.json').write_text(json.dumps(cp),encoding='utf-8')
PY
systemctl start giorgio-revalidate
sleep 8
python3 - <<'PY'
import json
from pathlib import Path
a=json.loads(Path('/tmp/cp-before-resume.json').read_text())
b=json.loads(Path('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json').read_text())
ta=set((a.get('terminal') or {}))
tb=set((b.get('terminal') or {}))
print('RESUME_TERMINAL_KEPT', ta.issubset(tb), 'before', len(ta), 'after', len(tb))
PY
systemctl stop giorgio-revalidate || true
sleep 2

# Remove canary restriction — client will start full 877 later
rm -f /etc/systemd/system/giorgio-revalidate.service.d/canary.conf
systemctl daemon-reload
systemctl enable giorgio-revalidate
systemctl stop giorgio-revalidate || true

SHA_AFTER=$(sha256sum "$DB" | awk '{print $1}')
HC_AFTER=$(python3 -c "import sqlite3;print(sqlite3.connect('$DB').execute(\"select count(*) from Lead where type='HEALTHCARE'\").fetchone()[0])")
echo "SHA_AFTER=$SHA_AFTER HC_AFTER=$HC_AFTER"
test "$SHA_BEFORE" = "$SHA_AFTER"
test "$HC_AFTER" = "877"

cd "$UI"
SCAN_ENGINE_LOCAL=1 DATABASE_URL="file:$DB" npx tsx scripts/test-regression-corpus.mjs 2>&1 | tee /tmp/corpus-out.txt | tail -20

# false HOT/PUB/SI on canary results
python3 - <<'PY'
import json
from pathlib import Path
root=Path('/opt/leadsniper-revalidate/data/revalidation/results')
false_hot=false_pub=false_si=0
n=0
for p in root.glob('*.json'):
  n+=1
  j=json.loads(p.read_text(encoding='utf-8'))
  # heuristic: empty evidence but certified = false
  ps=j.get('processingState') or j.get('semantic',{}).get('processingState')
  ev=(j.get('evidence') or '')
  if ps=='HOT_VERIFIED' and not ev.strip(): false_hot+=1
  if ps in ('PUBLISHED_CURRENT','PUBLISHED_EXPIRED','PUBLISHED_DATE_UNKNOWN') and not ev.strip(): false_pub+=1
  if ps=='SELF_INSURANCE_VERIFIED' and 'autoassicur' not in ev.lower() and 'autoritenzione' not in ev.lower():
    # soft check — count only if no SI keywords
    false_si+=1
print('RESULTS_N', n, 'FALSE_HOT', false_hot, 'FALSE_PUB', false_pub, 'FALSE_SI', false_si)
PY

RUN_N=$(curl -s 'http://127.0.0.1:3000/api/sanita/archive-revalidation/results?scope=run' | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('results')or[]))")
echo "RUN_RESULTS_API=$RUN_N"
echo "FINAL_ACTIVE=$(systemctl is-active giorgio-revalidate || true)"
echo "FINAL_ENABLED=$(systemctl is-enabled giorgio-revalidate)"
echo "CANARY_DONE GOT=$GOT"
