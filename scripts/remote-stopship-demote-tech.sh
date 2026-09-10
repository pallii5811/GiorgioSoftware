#!/usr/bin/env bash
# Demote TECHNICAL_BLOCKED terminals → operational retryQueue (preserve frontier/results).
set -euo pipefail
CP=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json
OUT=/tmp/stopship-forensic
sha256sum "$CP" | tee "$OUT/cp-before-demote.sha"
cp -a "$CP" "$OUT/checkpoint-before-demote.json"

python3 - <<'PY'
import json
from datetime import datetime, timezone
from pathlib import Path

cp_path = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
c = json.loads(cp_path.read_text())
terminal = c.get("terminal") or {}
retry = c.get("retryQueue") or {}
results = Path("/opt/leadsniper-revalidate/data/revalidation/results")
results2 = Path("/opt/leadsniper-revalidate/app/data/revalidation/results")

def ps(v):
    if isinstance(v, str):
        return v.upper()
    return str((v or {}).get("processingState") or (v or {}).get("state") or "").upper()

def find_frontier(lid, term):
    # prefer result pass1 frontier
    for d in (results, results2):
        for name in (f"{lid}.json", f"{lid}.p1.json"):
            p = d / name
            if not p.exists():
                continue
            try:
                j = json.loads(p.read_text(encoding="utf-8", errors="replace"))
                fps = j.get("frontierPaths") or []
                if fps:
                    return fps[-1], (j.get("runIds") or [None])[-1]
                p1 = j.get("pass1") or {}
                if p1.get("frontierPath"):
                    return p1["frontierPath"], p1.get("runId")
            except Exception:
                pass
    return None, None

demoted = []
now = datetime.now(timezone.utc).isoformat()
for lid, meta in list(terminal.items()):
    if ps(meta) != "TECHNICAL_BLOCKED":
        continue
    fp, run_id = find_frontier(lid, meta)
    prior = int((c.get("attempts") or {}).get(lid) or 1)
    retry[lid] = {
        "attempts": 0,
        "lastReason": "DEMOTED_FROM_TECHNICAL_BLOCKED",
        "lastError": (meta.get("reasonCode") if isinstance(meta, dict) else None) or "TECHNICAL_BLOCKED",
        "nextRetryAt": now,  # eligible immediately for corpus
        "lastRunId": run_id,
        "frontierPath": fp,
        "firstSeenAt": (meta.get("finishedAt") if isinstance(meta, dict) else None) or now,
        "lastAttemptAt": now,
        "demotedAt": now,
        "operational": True,
        "priorAttemptsBeforeDemote": prior,
    }
    c.setdefault("attempts", {})[lid] = 0
    del terminal[lid]
    demoted.append({"id": lid, "frontierPath": fp, "runId": run_id, "priorAttempts": prior})
    # adjust cumulative stats carefully (non-destructive floor at 0)
    st = c.setdefault("stats", {})
    st["tech"] = max(0, int(st.get("tech") or 0) - 1)
    st["terminal"] = max(0, int(st.get("terminal") or 0) - 1)
    st["retry"] = int(st.get("retry") or 0) + 1

c["terminal"] = terminal
c["retryQueue"] = retry
c["updatedAt"] = now
c["inProgress"] = c.get("inProgress") or {}
tmp = cp_path.with_suffix(".json.tmp")
tmp.write_text(json.dumps(c, ensure_ascii=False, indent=2), encoding="utf-8")
tmp.replace(cp_path)
Path("/tmp/stopship-forensic/demoted.json").write_text(json.dumps(demoted, indent=2), encoding="utf-8")
print(json.dumps({
    "demoted": len(demoted),
    "terminal": len(terminal),
    "retry": len(retry),
    "inProgress": len(c["inProgress"]),
    "processed": (c.get("stats") or {}).get("processed"),
}, indent=2))
PY

sha256sum "$CP" | tee "$OUT/cp-after-demote.sha"
echo DEMOTE_OK
