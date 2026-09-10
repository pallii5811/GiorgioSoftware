#!/usr/bin/env bash
set -euo pipefail

python3 - <<'PY'
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone

path = "/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"
with open(path, encoding="utf-8") as handle:
    cp = json.load(handle)

queue = cp.get("retryQueue", {})
now = datetime.now(timezone.utc)
reasons = Counter()
errors = Counter()
strategies = Counter()
attempts = Counter()
due = 0
frontier = 0
force_due = 0
samples = defaultdict(list)

for lead_id, meta in queue.items():
    reason = str(meta.get("lastReason") or "NONE")
    error = str(meta.get("lastError") or "NONE")
    strategy = str(meta.get("strategy") or "NONE")
    attempt = int(meta.get("attempts") or 0)
    reasons[reason] += 1
    errors[error[:160]] += 1
    strategies[strategy] += 1
    attempts[str(attempt)] += 1
    if meta.get("frontierPath"):
        frontier += 1
    if meta.get("forceDue"):
        force_due += 1
    raw_due = meta.get("nextRetryAt")
    if not raw_due:
        due += 1
    else:
        try:
            parsed = datetime.fromisoformat(raw_due.replace("Z", "+00:00"))
            if parsed <= now:
                due += 1
        except ValueError:
            due += 1
    if len(samples[reason]) < 5:
        samples[reason].append({
            "id": lead_id,
            "attempts": attempt,
            "lastError": error[:220],
            "strategy": strategy,
            "frontier": bool(meta.get("frontierPath")),
            "nextRetryAt": raw_due,
        })

print(json.dumps({
    "total": len(queue),
    "dueNow": due,
    "withFrontier": frontier,
    "forceDue": force_due,
    "reasons": reasons.most_common(),
    "attempts": sorted(attempts.items(), key=lambda item: int(item[0])),
    "strategies": strategies.most_common(),
    "topErrors": errors.most_common(25),
    "highAttemptRows": [
        {
            "id": lead_id,
            **meta,
        }
        for lead_id, meta in queue.items()
        if int(meta.get("attempts") or 0) >= 3
    ],
    "topReasonSamples": {
        reason: samples[reason]
        for reason, _ in reasons.most_common(12)
    },
    "inProgress": cp.get("inProgress", {}),
}, indent=2))
PY
