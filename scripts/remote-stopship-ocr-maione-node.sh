#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
import sqlite3
fp="/opt/leadsniper-revalidate/app/data/revalidation/frontiers/reval-p1-cmqkld5s700a8108eti0nofjv-1784574907297.sqlite"
c=sqlite3.connect(f"file:{fp}?mode=ro", uri=True)
print("evidence rows for pdf node:")
for r in c.execute(
  "SELECT id, extractedAt, ocrStatus, length(normalizedText), substr(normalizedText,1,100) "
  "FROM CrawlNodeEvidence WHERE nodeId=?",
  ("fn_mrtlwczd_45msftd0",),
):
  print(r)
print("node", c.execute(
  "SELECT state, updatedAt, completedAt, lastError, contentHash FROM CrawlFrontierNode WHERE id=?",
  ("fn_mrtlwczd_45msftd0",),
).fetchone())
print("run", c.execute("SELECT state, stopReason, currentCheckpoint, heartbeatAt FROM CrawlRun").fetchone())
c.close()
PY
