#!/usr/bin/env bash
# Deeper retry sample: reasonCode + evidence markers (no restart)
set -uo pipefail
python3 - <<'PY'
import json, re, collections
from pathlib import Path
res_dir = Path("/opt/leadsniper-revalidate/data/revalidation/results")
cp = json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
files = sorted(res_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
files = [p for p in files if ".p1." not in p.name and ".p2." not in p.name]
rows=[]
for p in files[:40]:
    rows.append(json.loads(p.read_text()))

# Focus RETRY / TECH
focus=[r for r in rows if r.get("processingState") in ("RETRY_PENDING","TECHNICAL_BLOCKED")]
print("focus", len(focus))
reason_counts=collections.Counter()
state_tag=collections.Counter()
ocr_warn_only=0
for r in focus:
    rc=r.get("reasonCode") or "(none)"
    reason_counts[rc]+=1
    ev=r.get("fullEvidence") or ""
    for m in re.findall(r"\[STATE:([A-Z_]+)\]", ev):
        state_tag[m]+=1
    has_special = "special-words" in ev or "OCR" in (r.get("error") or "")
    # true infra: LEAD_WALL / timeout / 403 etc in reason or pass error
    err = " ".join([
        str(r.get("error") or ""),
        str((r.get("pass1") or {}).get("error") or ""),
        str(r.get("reasonCode") or ""),
    ])
    print(json.dumps({
        "id": r.get("id"),
        "company": r.get("companyName"),
        "website": r.get("website"),
        "reasonCode": rc,
        "wallMs": r.get("wallMs") or (r.get("pass1") or {}).get("wallMs"),
        "attempts": (cp.get("attempts") or {}).get(r.get("id")),
        "pass1_error": (r.get("pass1") or {}).get("error"),
        "crawlComplete": r.get("crawlComplete"),
        "policyFound": r.get("policyFound"),
        "evidence_head": ev[:220].replace("\n"," "),
        "err_blob": err[:180],
        "has_special_words_in_evidence": "special-words" in ev,
    }, ensure_ascii=False))

print("REASON_COUNTS", json.dumps(reason_counts, indent=2))
print("STATE_TAGS", json.dumps(state_tag, indent=2))

# tessdata check
import os
td=os.environ.get("TESSDATA_PREFIX") or "/opt/leadsniper-revalidate/app/.tesseract-cache"
print("TESSDATA_PREFIX_DIR", td)
print("files", sorted(os.listdir(td))[:30] if os.path.isdir(td) else "missing")
# cwd of running process?
import subprocess
out=subprocess.check_output(["systemctl","show","giorgio-revalidate","-p","MainPID","-p","WorkingDirectory","-p","Environment"], text=True)
print(out)
PY
