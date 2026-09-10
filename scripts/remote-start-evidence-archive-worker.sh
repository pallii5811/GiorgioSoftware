#!/usr/bin/env bash
# Parallel evidence archive for certified PUB results (does not block revalidate).
set -euo pipefail
RESULTS=/opt/leadsniper-revalidate/data/revalidation/results
ARCHIVE=/opt/leadsniper/data/evidence-archive
BASELINE=/opt/leadsniper/backups/published-legacy-baseline-20260721T155725Z/published-legacy-baseline.json
mkdir -p "$ARCHIVE"
LOG=$ARCHIVE/archive-worker.log

python3 - <<'PY' >>"$LOG" 2>&1 &
import json, os, time, hashlib, urllib.request, re, pathlib, traceback
RESULTS="/opt/leadsniper-revalidate/data/revalidation/results"
ARCHIVE="/opt/leadsniper/data/evidence-archive"
BASELINE="/opt/leadsniper/backups/published-legacy-baseline-20260721T155725Z/published-legacy-baseline.json"
os.makedirs(ARCHIVE, exist_ok=True)
seen=set()
idx_path=os.path.join(ARCHIVE,"index.ndjson")
baseline={}
try:
  for r in json.load(open(BASELINE)).get("records",[]):
    baseline[r["leadId"]]=r
except Exception as e:
  print("baseline_load_error", e)

def archive_one(path):
  row=json.load(open(path))
  lid=row.get("leadId") or row.get("id") or pathlib.Path(path).stem
  ps=row.get("processingState") or ""
  if not str(ps).startswith("PUBLISHED"):
    return
  if lid in seen: return
  seen.add(lid)
  docs=None
  ev=row.get("evidence") or row.get("newEvidence") or ""
  m=re.search(r"\[DOCS:\s*([^\]]+)\]", ev or "", re.I)
  if m: docs=m.group(1).strip()
  if not docs:
    docs=row.get("policyPdfUrl") or row.get("sourceUrl")
  entry={
    "leadId": lid,
    "processingState": ps,
    "sourceUrl": docs,
    "archivedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "old": None,
    "compareStatus": None,
  }
  old=baseline.get(lid)
  if old:
    entry["old"]={
      "verdetto": old.get("vecchioVerdetto"),
      "stato": old.get("statoValidazione"),
      "docs": old.get("urlDocumentoOPagina"),
      "hashRecord": old.get("hashRecord"),
    }
    if old.get("statoValidazione")==ps and old.get("urlDocumentoOPagina")==docs:
      entry["compareStatus"]="CONFIRMED"
    elif str(ps).startswith("PUBLISHED"):
      entry["compareStatus"]="UPDATED"
    else:
      entry["compareStatus"]="REGRESSION"
  dest_dir=os.path.join(ARCHIVE, lid)
  os.makedirs(dest_dir, exist_ok=True)
  open(os.path.join(dest_dir,"result.json"),"w").write(json.dumps(row,indent=2))
  if docs and docs.startswith("http"):
    try:
      req=urllib.request.Request(docs, headers={"User-Agent":"giorgio-evidence-archive/1.0"})
      data=urllib.request.urlopen(req, timeout=60).read()
      sha=hashlib.sha256(data).hexdigest()
      ext=".pdf" if ".pdf" in docs.lower() else ".bin"
      fname=f"acquired-{sha[:16]}{ext}"
      open(os.path.join(dest_dir,fname),"wb").write(data)
      entry["acquired"]={"path": os.path.join(dest_dir,fname), "sha256": sha, "bytes": len(data)}
    except Exception as e:
      entry["acquireError"]=str(e)
  open(idx_path,"a").write(json.dumps(entry)+"\n")
  print(json.dumps({"archived": lid, "ps": ps, "docs": docs, "compare": entry.get("compareStatus")}))

print(json.dumps({"event":"archive_worker_start"}))
while True:
  try:
    if os.path.isdir(RESULTS):
      for name in os.listdir(RESULTS):
        if not name.endswith(".json"): continue
        try: archive_one(os.path.join(RESULTS,name))
        except Exception:
          traceback.print_exc()
  except Exception:
    traceback.print_exc()
  time.sleep(30)
PY
echo $! > "$ARCHIVE/archive-worker.pid"
echo "EVIDENCE_ARCHIVE_WORKER_PID=$(cat $ARCHIVE/archive-worker.pid)"
