#!/usr/bin/env python3
"""Write STOP-SHIP report snapshot (targeted still running)."""
import json
from pathlib import Path

diag = json.loads(Path("/opt/leadsniper-revalidate/data/stopship-retry11/RETRY11_DIAGNOSIS.json").read_text())
# enrich with real errors from earlier dump knowledge
matrix = []
for e in diag["leads"]:
    matrix.append(
        {
            "leadId": e["leadId"],
            "company": e.get("companyName"),
            "website": e.get("website"),
            "attempts": e.get("attempts"),
            "lastReason": e.get("lastReason"),
            "class": e["diagnosis"]["class"],
            "rootCauses": e["diagnosis"]["rootCauses"],
        }
    )

base = json.loads(Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun/baseline.json").read_text())
cp = json.loads(Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun/checkpoint.json").read_text())
out = {
    "NOTE": "At pause there were 16 retries (grew past the 11 mentioned). All 16 in targeted rerun.",
    "RETRY_MATRIX": matrix,
    "ENGINE_BUGS": [
        "PLAYWRIGHT_BROWSER_MISSING: chromium.launch ignored PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/snap/bin/chromium",
        "NEW_LEAD_10M_WALL: pending=0 on missing frontier incorrectly applied finalize stretch 600000ms",
        "OPAQUE_ANALYZE_ERROR: worker mapped all thrown errors to ANALYZE_ERROR_OR_TIMEOUT",
        "HTML_RELEVANCE_FLOOD: every html-link marked relevant → fake CRAWL_CAP / unresolved_cr hundreds",
        "OCR/PDF incomplete + LEAD_WALL on heavy PDF sites (Malzoni)",
    ],
    "EXTERNAL_FAILURES": [],
    "PATCH_COMMIT": "40574b7263c0834da51404d25cfc1f375ab0db36",
    "RUNTIME_SHA": "40574b7263c0834da51404d25cfc1f375ab0db36",
    "TARGETED_TERMINAL": len(cp.get("terminal") or {}),
    "TARGETED_RETRY": len(cp.get("retryQueue") or {}),
    "TARGETED_IN_PROGRESS": list((cp.get("inProgress") or {}).keys()),
    "TECHNICAL_BLOCKED_WITH_PROOF": 0,
    "FALSE_TERMINALS": [],
    "DB_SHA": base.get("dbSha"),
    "CHECKPOINT_SHA": base.get("prodCheckpointSha"),
    "READY_TO_RESUME_877": False,
    "JOB_STATUS": "giorgio-revalidate inactive; targeted rerun running isolated",
}
Path("/opt/leadsniper-revalidate/data/stopship-retry11/STOPSHIP_OUTPUT.json").write_text(
    json.dumps(out, indent=2, ensure_ascii=False)
)
print(json.dumps(out, indent=2, ensure_ascii=False))
