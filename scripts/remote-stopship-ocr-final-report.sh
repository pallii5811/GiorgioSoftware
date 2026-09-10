#!/usr/bin/env bash
set -euo pipefail
pkill -f "production-revalidate-sanita-v3.mjs" 2>/dev/null || true
pkill -f "production-revalidate-sanita-worker.mjs" 2>/dev/null || true
sleep 2
pkill -9 -f "production-revalidate-sanita-v3.mjs" 2>/dev/null || true
pkill -9 -f "production-revalidate-sanita-worker.mjs" 2>/dev/null || true
rm -f /opt/leadsniper-revalidate/data/revalidation/locks/*.lock
echo "systemd=$(systemctl is-active giorgio-revalidate || true)"
echo "RELEASE_SHA=$(cat /opt/leadsniper-revalidate/app/RELEASE_SHA 2>/dev/null || true)"
sha256sum /opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker.mjs
sha256sum /opt/leadsniper-revalidate/app/src/lib/sanita/ocr.ts
systemctl show giorgio-revalidate -p Environment --no-pager | tr ' ' '\n' | grep -E 'PDFTOPPM_PATH|^PATH=' || true
python3 - <<'PY'
import json, sqlite3
from pathlib import Path

def frontier(fp):
  if not Path(fp).exists():
    return None
  c=sqlite3.connect(f"file:{fp}?mode=ro", uri=True)
  by=dict(c.execute("SELECT state, COUNT(*) FROM CrawlFrontierNode GROUP BY state").fetchall())
  ev=c.execute(
    "SELECT ocrStatus, length(normalizedText), substr(canonicalUrl,1,100), extractedAt "
    "FROM CrawlNodeEvidence WHERE resourceType='pdf' OR lower(canonicalUrl) LIKE '%.pdf%' "
    "ORDER BY extractedAt DESC"
  ).fetchall()
  pdf_states=c.execute(
    "SELECT state, COUNT(*) FROM CrawlFrontierNode "
    "WHERE resourceType='pdf' OR lower(canonicalUrl) LIKE '%.pdf%' GROUP BY state"
  ).fetchall()
  run=c.execute(
    "SELECT state, stopReason, totalFailed, totalPending, totalCompleted FROM CrawlRun ORDER BY rowid DESC LIMIT 1"
  ).fetchone()
  c.close()
  return {
    "byState": by,
    "pdfByState": dict(pdf_states),
    "pdfEvidence": [list(x) for x in ev],
    "run": list(run) if run else None,
  }

def lead(path):
  d=json.loads(Path(path).read_text())
  ev=d.get("fullEvidence") or ""
  return {
    "processingState": d.get("processingState"),
    "reasonCode": d.get("reasonCode"),
    "finishedAt": d.get("finishedAt"),
    "OCR_RENDERER_MISSING": "OCR_RENDERER_MISSING" in ev,
    "HOT": d.get("token")=="HOT" or d.get("processingState")=="HOT_VERIFIED",
    "PUBLISHED": str(d.get("processingState") or "").startswith("PUBLISHED"),
  }

summary = {
  "ocrRendererMissingLogCount": open("/opt/leadsniper-revalidate/logs/stopship-ocr-canary2.log").read().count("OCR_RENDERER_MISSING"),
  "maioneResult": lead("/opt/leadsniper-revalidate/data/revalidation/results/cmqkld5s700a8108eti0nofjv.json"),
  "albaResult": lead("/opt/leadsniper-revalidate/data/revalidation/results/cmql46eia000ac9w78xh0rxdl.json"),
  "maioneFrontier": frontier("/opt/leadsniper-revalidate/app/data/revalidation/frontiers/reval-p1-cmqkld5s700a8108eti0nofjv-1784574907297.sqlite"),
  "albaFrontier": frontier("/opt/leadsniper-revalidate/app/data/revalidation/frontiers/reval-p1-cmql46eia000ac9w78xh0rxdl-1784579490121.sqlite"),
  "probe": None,
}
probe = Path("/tmp/stopship-ocr-diag/maione-pdf-ocr-probe.json")
if probe.exists():
  p=json.loads(probe.read_text())
  summary["probe"] = {
    "resolved": p.get("resolved"),
    "withGateStatus": (p.get("withGate") or {}).get("status"),
    "withOcrStatus": (p.get("withOcr") or {}).get("status"),
    "rendererPath": ((p.get("withOcr") or {}).get("rasterize") or {}).get("rendererPath"),
  }
before = Path("/tmp/stopship-ocr-diag/canary-frontier-before-v2.json")
if before.exists():
  summary["frontierBefore"] = json.loads(before.read_text())
Path("/tmp/stopship-ocr-diag/CANARY2-FINAL.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False))
print(json.dumps(summary, indent=2, ensure_ascii=False))
print("CORPUS12_GATE", "PASS" if summary["ocrRendererMissingLogCount"]==0 and not summary["maioneResult"]["OCR_RENDERER_MISSING"] and not summary["albaResult"]["OCR_RENDERER_MISSING"] and not summary["maioneResult"]["HOT"] and not summary["albaResult"]["HOT"] and not summary["maioneResult"]["PUBLISHED"] and not summary["albaResult"]["PUBLISHED"] else "FAIL")
PY
