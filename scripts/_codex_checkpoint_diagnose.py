#!/usr/bin/env python3
import collections
import datetime
import json
import os
import sys


def iso_epoch(value):
    try:
        return datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return 0


checkpoint_path = sys.argv[1]
with open(checkpoint_path, "r", encoding="utf-8") as handle:
    checkpoint = json.load(handle)

retry_queue = checkpoint.get("retryQueue", {})
attempts = checkpoint.get("attempts", {})
now = datetime.datetime.now(datetime.timezone.utc).timestamp()

reasons = collections.Counter()
reason_examples = collections.defaultdict(list)
strategies = collections.Counter()
passes = collections.Counter()
attempt_histogram = collections.Counter()
state_histogram = collections.Counter()
continuations = collections.Counter()
parked = collections.Counter()
due = 0

rows = []
for lead_id, meta in retry_queue.items():
    reason = str(meta.get("lastReason") or meta.get("lastError") or "UNKNOWN")
    attempt_count = int(meta.get("attempts") or attempts.get(lead_id) or 0)
    next_retry = iso_epoch(meta.get("nextRetryAt"))
    frontier = meta.get("frontierSnapshot") or {}

    reasons[reason] += 1
    if len(reason_examples[reason]) < 8:
        reason_examples[reason].append(lead_id)
    strategies[str(meta.get("strategy") or "NONE")] += 1
    passes[str(meta.get("passLabel") or "NONE")] += 1
    attempt_histogram[attempt_count] += 1
    state_histogram[str(frontier.get("state") or "NONE")] += 1
    continuations[str(meta.get("continuationReady"))] += 1
    parked[str(meta.get("parked"))] += 1
    if next_retry <= now:
        due += 1

    rows.append(
        {
            "id": lead_id,
            "attempts": attempt_count,
            "reason": reason,
            "strategy": meta.get("strategy"),
            "pass": meta.get("passLabel"),
            "continuation": meta.get("continuationReady"),
            "parked": meta.get("parked"),
            "stall": meta.get("stallCount"),
            "pending": frontier.get("pending"),
            "blocked": frontier.get("blocked"),
            "pdfPending": frontier.get("pdfPending"),
            "completed": frontier.get("completed"),
            "excluded": frontier.get("excluded"),
            "totalNodes": frontier.get("totalNodes"),
            "frontierState": frontier.get("state"),
            "nextRetryAt": meta.get("nextRetryAt"),
            "lastAttemptAt": meta.get("lastAttemptAt"),
            "frontierPath": meta.get("frontierPath"),
        }
    )

rows.sort(key=lambda row: (row["attempts"], iso_epoch(row["lastAttemptAt"]), row["id"]))

summary = {
    "updatedAt": checkpoint.get("updatedAt"),
    "terminal": len(checkpoint.get("terminal", {})),
    "retry": len(retry_queue),
    "inProgress": checkpoint.get("inProgress", {}),
    "due": due,
    "reasons": reasons.most_common(),
    "reasonExamples": dict(reason_examples),
    "strategies": strategies.most_common(),
    "passes": passes.most_common(),
    "attemptHistogram": sorted(attempt_histogram.items()),
    "frontierStates": state_histogram.most_common(),
    "continuationReady": continuations.most_common(),
    "parked": parked.most_common(),
    "lowestAttempts": rows[:25],
    "highestAttempts": sorted(rows, key=lambda row: (-row["attempts"], row["id"]))[:25],
    "completedFrontierCandidates": [
        row
        for row in rows
        if row["frontierState"] == "COMPLETED"
        and row["pending"] == 0
        and row["blocked"] == 0
        and row["pdfPending"] == 0
    ],
}
print(json.dumps(summary, ensure_ascii=False, indent=2))
