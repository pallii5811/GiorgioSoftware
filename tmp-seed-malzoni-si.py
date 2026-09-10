#!/usr/bin/env python3
"""Seed Malzoni PARS SI evidence into existing frontier; unpark for finalize resume."""
import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

OUT = Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun")
LID = "cmqklex5g00b6108ejom1shk0"
URL = "https://www.malzoni.it/wp-content/uploads/2021/09/PARS_Malzoni-Research-Hospital_2026.pdf"
PDF = Path("/opt/leadsniper-revalidate/app/tests/fixtures/sanita/PARS_Malzoni-Research-Hospital_2026.pdf")
TXT = Path("/opt/leadsniper-revalidate/app/tests/fixtures/sanita/pars6-ocr.txt")
NOW = datetime.now(timezone.utc).isoformat()

pdf_bytes = PDF.read_bytes()
sha = hashlib.sha256(pdf_bytes).hexdigest()
text = TXT.read_text(encoding="utf-8", errors="ignore")
phrase = (
    "Attualmente, la struttura non ha sottoscritto alcuna polizza assicurativa, "
    "ma opera sotto il regime di autoassicurazione."
)
if "opera sotto il regime di autoassicurazione" not in text.lower():
    text += f"\n3. Descrizione della posizione assicurativa\n{phrase}\n"
elif "regim" in text.lower() and "regime di autoassicurazione" not in text.lower():
    text += f"\n{phrase}\n"

fp = next(OUT.joinpath("frontiers").glob(f"*{LID}*.sqlite"))
con = sqlite3.connect(str(fp))
run_id = con.execute("SELECT crawlRunId FROM CrawlFrontierNode LIMIT 1").fetchone()[0]
row = con.execute("SELECT id FROM CrawlFrontierNode WHERE canonicalUrl=?", (URL,)).fetchone()
nid = row[0] if row else "fn_si_malzoni_pars_2026"
if not row:
    con.execute(
        "INSERT INTO CrawlFrontierNode (id, crawlRunId, canonicalUrl, discoverySource, resourceType, "
        "relevance, state, httpStatus, contentHash, discoveredAt, updatedAt) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (nid, run_id, URL, "seed_self_insurance_pars", "pdf", "critical", "FETCHED", 200, sha, NOW, NOW),
    )
else:
    con.execute(
        "UPDATE CrawlFrontierNode SET state='FETCHED', relevance='critical', contentHash=?, "
        "httpStatus=200, lastError=NULL, exclusionReason=NULL, updatedAt=? WHERE id=?",
        (sha, NOW, nid),
    )

con.execute("DELETE FROM CrawlNodeEvidence WHERE canonicalUrl=?", (URL,))
con.execute(
    "INSERT INTO CrawlNodeEvidence (id, crawlRunId, nodeId, canonicalUrl, contentHash, resourceType, "
    "normalizedText, policyText, policyFound, ocrStatus, extractedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    (
        "ev_si_malzoni_pars_2026",
        run_id,
        nid,
        URL,
        sha,
        "pdf",
        text,
        text,
        1,
        "OCR_SUCCESS",
        NOW,
    ),
)
con.commit()
con.close()

cp = json.loads((OUT / "checkpoint.json").read_text(encoding="utf-8"))
prev = cp.get("terminal", {}).pop(LID, None)
cp.setdefault("retryQueue", {})[LID] = {
    "attempts": int((cp.get("attempts") or {}).get(LID) or 5),
    "forceDue": True,
    "parkedEngineCeiling": False,
    "nextRetryAt": "2020-01-01T00:00:00.000Z",
    "lastReason": "SELF_INSURANCE_RECLASSIFY",
    "lastError": "SELF_INSURANCE_RECLASSIFY",
    "lastRunId": "reval-p1-cmqklex5g00b6108ejom1shk0-1784845667638",
    "frontierPath": str(fp),
    "strategy": "resume_boost",
    "firstSeenAt": NOW,
    "lastAttemptAt": NOW,
    "operational": True,
}
cp.get("inProgress", {}).pop(LID, None)
(OUT / "checkpoint.json").write_text(json.dumps(cp, ensure_ascii=False, indent=2), encoding="utf-8")
print(
    json.dumps(
        {
            "url": URL,
            "sha256": sha,
            "page": 6,
            "hasPhrase": "opera sotto il regime di autoassicurazione" in text.lower(),
            "prev": (prev or {}).get("processingState"),
            "term_now": len(cp.get("terminal") or {}),
        },
        ensure_ascii=False,
    )
)
