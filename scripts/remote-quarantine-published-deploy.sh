#!/usr/bin/env bash
# Quarantine v3 PUBLISHED_* → retry; deploy canonical worker; resume @2. Preserve HOT dual + unrelated TECH.
set -uo pipefail
WORKDIR=/opt/leadsniper-revalidate
APP=$WORKDIR/app
DATA=$WORKDIR/data/revalidation

echo "=== ENSURE STOPPED ==="
systemctl stop giorgio-revalidate || true
pkill -f 'production-revalidate-sanita' 2>/dev/null || true
sleep 2

echo "=== DEPLOY ==="
cp -f /tmp/production-revalidate-sanita-worker.mjs "$APP/scripts/"
cp -f /tmp/canonical-published-terminal.ts "$APP/src/lib/sanita/"
cp -f /tmp/scan-engine.ts "$APP/src/lib/sanita/scan-engine.ts"
# keep parent/crawl as currently running versions unless provided
if [ -f /tmp/production-revalidate-sanita-v3.mjs ]; then
  cp -f /tmp/production-revalidate-sanita-v3.mjs "$APP/scripts/"
fi
sha256sum "$APP/scripts/production-revalidate-sanita-worker.mjs" /tmp/production-revalidate-sanita-worker.mjs
sha256sum "$APP/src/lib/sanita/canonical-published-terminal.ts" /tmp/canonical-published-terminal.ts
sha256sum "$APP/src/lib/sanita/scan-engine.ts" /tmp/scan-engine.ts

echo "=== QUARANTINE PUBLISHED_* ==="
python3 - <<'PY'
import json
from pathlib import Path
from datetime import datetime, timezone
p=Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
cp=json.loads(p.read_text())
now=datetime.now(timezone.utc).isoformat()
res=Path("/opt/leadsniper-revalidate/data/revalidation/results")
quarantined=[]

# 1) from terminal
for lid, meta in list((cp.get("terminal") or {}).items()):
  ps=str(meta.get("processingState") or "")
  if ps.startswith("PUBLISHED"):
    quarantined.append({"id": lid, "from": "terminal", "ps": ps})
    prev=(cp.get("retryQueue") or {}).get(lid) or {}
    cp.setdefault("retryQueue", {})[lid]={
      "attempts": prev.get("attempts") or (cp.get("attempts") or {}).get(lid, 1),
      "lastReason": "PUBLISHED_QUARANTINE_REGEX_INVENTION",
      "lastError": f"quarantine_{ps}",
      "nextRetryAt": "1970-01-01T00:00:00.000Z",
      "lastRunId": prev.get("lastRunId"),
      "frontierPath": prev.get("frontierPath"),
      "firstSeenAt": prev.get("firstSeenAt") or now,
      "lastAttemptAt": now,
    }
    del cp["terminal"][lid]

# 2) from results with PUBLISHED_* even if not in terminal (v3 forged)
for f in res.glob("*.json"):
  if f.name.endswith(".p1.json") or f.name.endswith(".p2.json"):
    continue
  try: row=json.loads(f.read_text())
  except: continue
  lid=row.get("id")
  if not lid: continue
  ps=str(row.get("processingState") or "")
  if not ps.startswith("PUBLISHED"):
    continue
  if lid in (cp.get("terminal") or {}):
    continue  # already handled or HOT-only path
  if lid in (cp.get("retryQueue") or {}) and any(q["id"]==lid for q in quarantined):
    continue
  if lid not in (cp.get("retryQueue") or {}):
    cp.setdefault("retryQueue", {})[lid]={
      "attempts": (cp.get("attempts") or {}).get(lid, 1),
      "lastReason": "PUBLISHED_QUARANTINE_REGEX_INVENTION",
      "lastError": f"quarantine_result_{ps}",
      "nextRetryAt": "1970-01-01T00:00:00.000Z",
      "lastRunId": (row.get("runIds") or [None])[0],
      "frontierPath": (row.get("frontierPaths") or [None])[0],
      "firstSeenAt": now,
      "lastAttemptAt": now,
    }
    quarantined.append({"id": lid, "from": "results", "ps": ps})
  elif lid not in [q["id"] for q in quarantined]:
    cp["retryQueue"][lid]["nextRetryAt"]="1970-01-01T00:00:00.000Z"
    cp["retryQueue"][lid]["lastReason"]="PUBLISHED_QUARANTINE_REGEX_INVENTION"
    quarantined.append({"id": lid, "from": "retry_force", "ps": ps})

# 3) CardioProgress mandatory
CARDIO="cmql4d390000oc9w70lelcqnp"
if CARDIO in (cp.get("terminal") or {}):
  meta=cp["terminal"].pop(CARDIO)
  quarantined.append({"id": CARDIO, "from": "terminal_cardio_forced", "ps": meta.get("processingState")})
cp.setdefault("retryQueue", {})[CARDIO]={
  **((cp.get("retryQueue") or {}).get(CARDIO) or {}),
  "attempts": (cp.get("retryQueue") or {}).get(CARDIO, {}).get("attempts") or (cp.get("attempts") or {}).get(CARDIO, 1),
  "lastReason": "PUBLISHED_QUARANTINE_REGEX_INVENTION",
  "lastError": "cardio_mandatory_revalidate",
  "nextRetryAt": "1970-01-01T00:00:00.000Z",
  "firstSeenAt": now,
  "lastAttemptAt": now,
}
if not any(q["id"]==CARDIO for q in quarantined):
  quarantined.append({"id": CARDIO, "from": "cardio_mandatory", "ps": "PUBLISHED_EXPIRED"})

# move inProgress → retry due (preserve frontiers)
for lid, meta in list((cp.get("inProgress") or {}).items()):
  if lid in (cp.get("terminal") or {}):
    del cp["inProgress"][lid]
    continue
  prev=(cp.get("retryQueue") or {}).get(lid) or {}
  cp.setdefault("retryQueue", {})[lid]={
    "attempts": prev.get("attempts") or (cp.get("attempts") or {}).get(lid, 1),
    "lastReason": "IN_PROGRESS_INTERRUPTED",
    "lastError": "published_quarantine_stop",
    "nextRetryAt": "1970-01-01T00:00:00.000Z",
    "lastRunId": (meta or {}).get("runId") or prev.get("lastRunId"),
    "frontierPath": (meta or {}).get("frontierPath") or prev.get("frontierPath"),
    "firstSeenAt": prev.get("firstSeenAt") or now,
    "lastAttemptAt": now,
  }
  del cp["inProgress"][lid]

# recount light stats
term=cp.get("terminal") or {}
cp.setdefault("stats", {})
cp["stats"]["terminal"]=len(term)
cp["stats"]["hot"]=sum(1 for v in term.values() if v.get("processingState")=="HOT_VERIFIED")
cp["stats"]["pub"]=sum(1 for v in term.values() if str(v.get("processingState","")).startswith("PUBLISHED"))
cp["stats"]["tech"]=sum(1 for v in term.values() if v.get("processingState")=="TECHNICAL_BLOCKED")
cp["stats"]["review"]=sum(1 for v in term.values() if v.get("processingState")=="REVIEW_HUMAN")

p.write_text(json.dumps(cp, indent=2))
Path("/tmp/published-quarantine.json").write_text(json.dumps({"quarantined": quarantined, "terminal": len(term), "retry": len(cp.get("retryQueue") or {})}, indent=2))
print(json.dumps({"quarantined": quarantined, "terminal": len(term), "retry": len(cp.get("retryQueue") or {}), "inProgress": 0, "hot_kept": [k for k,v in term.items() if v.get("processingState")=="HOT_VERIFIED"], "tech_kept": [k for k,v in term.items() if v.get("processingState")=="TECHNICAL_BLOCKED"]}, indent=2))
PY

rm -f "$DATA/locks"/*.lock 2>/dev/null || true
rm -f /opt/leadsniper-revalidate/revalidate.parent.lock

echo "=== RESUME @2 ==="
systemctl daemon-reload
systemctl reset-failed giorgio-revalidate || true
systemctl start giorgio-revalidate
sleep 12
systemctl is-active giorgio-revalidate
pgrep -af 'flock.*revalidate.parent' | head -2
tail -n 30 /opt/leadsniper-revalidate/logs/systemd-revalidate.log | tr -d '\000' | tail -n 30
python3 -c 'import json;cp=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"));print(json.dumps({"terminal":len(cp.get("terminal")or{}),"retry":len(cp.get("retryQueue")or{}),"inProgress":list((cp.get("inProgress")or{}).keys()),"pubs_in_terminal":[k for k,v in (cp.get("terminal")or{}).items() if str(v.get("processingState","")).startswith("PUBLISHED")]}))'
