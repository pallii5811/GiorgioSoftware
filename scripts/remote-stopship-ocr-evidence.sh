#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
import sqlite3, json
from pathlib import Path

def dump(fp, label):
  c=sqlite3.connect(f"file:{fp}?mode=ro", uri=True)
  cols=[r[1] for r in c.execute("PRAGMA table_info(CrawlNodeEvidence)")]
  rows=c.execute(
    "SELECT * FROM CrawlNodeEvidence WHERE resourceType='pdf' OR lower(canonicalUrl) LIKE '%.pdf%' ORDER BY extractedAt DESC"
  ).fetchall()
  print("===", label, "===")
  print("pdf_nodes", c.execute(
    "SELECT state, lastError, substr(canonicalUrl,1,120) FROM CrawlFrontierNode WHERE resourceType='pdf' OR lower(canonicalUrl) LIKE '%.pdf%'"
  ).fetchall())
  print("run", c.execute("SELECT state, stopReason, currentCheckpoint, heartbeatAt FROM CrawlRun").fetchone())
  print("byState", dict(c.execute("SELECT state, COUNT(*) FROM CrawlFrontierNode GROUP BY state")))
  for r in rows[:5]:
    d=dict(zip(cols,r))
    print(json.dumps({
      "extractedAt": d.get("extractedAt"),
      "url": (d.get("canonicalUrl") or "")[:120],
      "ocrStatus": d.get("ocrStatus"),
      "policyFound": d.get("policyFound"),
      "textLen": len(d.get("normalizedText") or ""),
      "textPreview": (d.get("normalizedText") or "")[:220],
    }, ensure_ascii=False))
  c.close()

dump("/opt/leadsniper-revalidate/app/data/revalidation/frontiers/reval-p1-cmqkld5s700a8108eti0nofjv-1784574907297.sqlite", "maione")
dump("/opt/leadsniper-revalidate/app/data/revalidation/frontiers/reval-p1-cmql46eia000ac9w78xh0rxdl-1784579490121.sqlite", "alba")
print("OCR_RENDERER_MISSING", open("/opt/leadsniper-revalidate/logs/stopship-ocr-canary2.log").read().count("OCR_RENDERER_MISSING"))
# heartbeats with ocr_renderer
for ln in open("/opt/leadsniper-revalidate/logs/stopship-ocr-canary2.log"):
  if "ocr_renderer" in ln or "OCR_" in ln:
    print("log", ln.strip()[:240])
PY
