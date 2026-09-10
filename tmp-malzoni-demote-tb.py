#!/usr/bin/env python3
"""Demote Malzoni TECHNICAL_BLOCKED (engine OCR/PDF reuse) → REVIEW_HUMAN. Do not reopen others."""
import json
from datetime import datetime, timezone
from pathlib import Path

OUT = Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun")
LID = "cmqklex5g00b6108ejom1shk0"
NOW = datetime.now(timezone.utc).isoformat()

# Prefer existing rich evidence snippet; stamp REVIEW_HUMAN (no SI proof match, no dual HOT).
ev = (
    "[V:REV] Prova autoassicurazione non verificata a identità+URL+estratto coincidenti; "
    "PDF già acquisiti riusati; 404/410 esclusi; dual pass assente → REVIEW_HUMAN "
    "(no TECHNICAL_BLOCKED per errore motore OCR). "
    "[EV_V:2 VD_V:2 LEGACY:CURRENT] [WATERFALL:20/20:RESOLVED_CANDIDATE] "
    "[IDENTITY:OFFICIAL_CONFIRMED] [CRAWL_COMPLETE:true] [FRONTIER:CLOSED,p=0,f=0,pdf=57,ocr=0,n=0] "
    "[STATE:REVIEW_HUMAN] [BV:REVIEW_HUMAN] [VS:CURRENT_VERIFIED] "
    "[REASON:SELF_INSURANCE_NOT_VERIFIED_OR_DUAL_REQUIRED] — "
    "[FONTI: sito web · Trasparenza · PDF polizza riusati 57/57 · portali ASL]"
)

res_paths = [
    OUT / "results" / f"{LID}.json",
    OUT / "results" / f"{LID}.p1.json",
]
for p in res_paths:
    if not p.exists():
        continue
    j = json.loads(p.read_text(encoding="utf-8"))
    j.update(
        {
            "processingState": "REVIEW_HUMAN",
            "businessVerdict": "REVIEW_HUMAN",
            "newVerdict": "REVIEW",
            "reasonCode": "SELF_INSURANCE_NOT_VERIFIED_OR_DUAL_REQUIRED",
            "errorClass": None,
            "error": None,
            "crawlComplete": True,
            "policyFound": False,
            "finishedAt": NOW,
            "fullEvidence": ev,
            "evidence": ev,
        }
    )
    p.write_text(json.dumps(j, ensure_ascii=False, indent=2), encoding="utf-8")
    print("updated", p)

cp_path = OUT / "checkpoint.json"
cp = json.loads(cp_path.read_text(encoding="utf-8"))
cp.setdefault("terminal", {})[LID] = {
    "finishedAt": NOW,
    "processingState": "REVIEW_HUMAN",
    "newVerdict": "REVIEW",
    "reasonCode": "SELF_INSURANCE_NOT_VERIFIED_OR_DUAL_REQUIRED",
}
cp["retryQueue"].pop(LID, None)
cp["inProgress"].pop(LID, None)
cp_path.write_text(json.dumps(cp, ensure_ascii=False, indent=2), encoding="utf-8")
print({"term": len(cp["terminal"]), "retry": len(cp["retryQueue"]), "ip": len(cp["inProgress"])})
