#!/usr/bin/env bash
# Drain engine-error retries → REVIEW_HUMAN; clear inProgress; leave only slice-continue if any (also drain all for zero-retry restart).
set -euo pipefail
CP="${1:-/opt/leadsniper-revalidate/data/revalidation/checkpoint.json}"
BACKUP="${CP}.bak-drain-$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "$CP" "$BACKUP"
python3 - "$CP" <<'PY'
import json, sys, datetime
path = sys.argv[1]
cp = json.load(open(path))
now = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%fZ")
rq = cp.get("retryQueue") or {}
ip = cp.get("inProgress") or {}
moved = 0
ENGINE = (
    "ANALYZE", "LEAD_WALL", "PLAYWRIGHT", "Executable", "WORKER_SIGTERM",
    "PARENT_CATCH", "OCR_", "RETRY_PENDING", "parent_restart", "TIMEOUT",
    "SITEMAP", "CRAWL_CAP", "FRONTIER_INCOMPLETE", "PDF_UNPROCESSED",
)
for lid, meta in list(rq.items()):
    err = f"{meta.get('lastError','')} {meta.get('lastReason','')} {meta.get('error','')}"
    # Zero-retry restart: terminalize ALL retries as REVIEW_HUMAN
    cp.setdefault("terminal", {})[lid] = {
        "finishedAt": now,
        "processingState": "REVIEW_HUMAN",
        "newVerdict": "REVIEW",
        "reasonCode": f"DRAIN_RETRY:{str(err)[:160]}",
        "drainedFromRetry": True,
    }
    del rq[lid]
    moved += 1
for lid in list(ip.keys()):
    if lid not in cp.get("terminal", {}):
        cp.setdefault("terminal", {})[lid] = {
            "finishedAt": now,
            "processingState": "REVIEW_HUMAN",
            "newVerdict": "REVIEW",
            "reasonCode": "DRAIN_IN_PROGRESS",
            "drainedFromInProgress": True,
        }
        moved += 1
    del ip[lid]
cp["retryQueue"] = rq
cp["inProgress"] = ip
cp["updatedAt"] = now
st = cp.setdefault("stats", {})
st["terminal"] = len(cp.get("terminal") or {})
st["retry"] = len(rq)
st["review"] = int(st.get("review") or 0) + moved
json.dump(cp, open(path, "w"), indent=2)
print(json.dumps({
    "backup": True,
    "moved_to_review": moved,
    "terminal": len(cp.get("terminal") or {}),
    "retry": len(rq),
    "inProgress": len(ip),
}, indent=2))
PY
echo "backup=$BACKUP"
