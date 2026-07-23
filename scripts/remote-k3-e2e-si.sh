#!/usr/bin/env bash
# Quick E2E: sanita 200, self-insurance filter, Malzoni in shadow results, export fields.
set -euo pipefail
BASE="${BASE_URL:-http://127.0.0.1:3000}"
OUT=/opt/leadsniper-revalidate/data/k3-stopship/E2E_FINAL.json
MID=cmqktyimz000i111hygme29nh

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/sanita")
echo "sanita=$code"

# shadow results API
RES=$(curl -s "$BASE/api/sanita/archive-revalidation/results?outcome=SELF_INSURANCE_VERIFIED&limit=50" || true)
# fallback outcome filter via processingState in results
ALL=$(curl -s "$BASE/api/sanita/archive-revalidation/results?limit=200" || true)
python3 - <<PY
import json, os, urllib.request
base=os.environ.get("BASE","$BASE")
mid="$MID"
out={}
# /sanita
import urllib.error
try:
  r=urllib.request.urlopen(base+"/sanita", timeout=30)
  out["sanita"]=r.status
except Exception as e:
  out["sanita"]=str(e)

# results
try:
  raw=urllib.request.urlopen(base+"/api/sanita/archive-revalidation/results?limit=300", timeout=60).read()
  j=json.loads(raw)
  rows=j.get("results") or j.get("rows") or j.get("items") or []
  if isinstance(j, list): rows=j
  out["resultsTotal"]=len(rows)
  si=[r for r in rows if (r.get("processingState")=="SELF_INSURANCE_VERIFIED" or r.get("businessVerdict")=="SELF_INSURANCE_VERIFIED")]
  out["selfInsuranceCount"]=len(si)
  mal=[r for r in si if r.get("leadId")==mid or mid in str(r.get("leadId",""))]
  out["malzoniInSI"]=bool(mal)
  if mal:
    m=mal[0]
    out["malzoni"]={"state":m.get("processingState"),"bv":m.get("businessVerdict"),"company":m.get("policyCompany") or m.get("companyName"),"urls":(m.get("evidenceUrls") or [])[:2]}
  pini=[r for r in si if r.get("leadId")=="cmqklex5q00bh108eq9blm01k"]
  out["piniInSI"]=bool(pini)
except Exception as e:
  out["resultsError"]=str(e)

# jobs active
try:
  raw=urllib.request.urlopen(base+"/api/sanita/jobs?active=1", timeout=20).read()
  j=json.loads(raw)
  out["activeJobs"]=len(j.get("jobs") or [])
except Exception as e:
  out["activeJobsError"]=str(e)

# release
try:
  out["releaseSha"]=open("/opt/leadsniper/RELEASE_SHA").read().strip()
except Exception:
  pass

out["pass"]= out.get("sanita")==200 and out.get("malzoniInSI") is True and out.get("selfInsuranceCount",0)>=1
open("$OUT","w").write(json.dumps(out,ensure_ascii=False,indent=2))
print(json.dumps(out,ensure_ascii=False,indent=2))
PY
