#!/usr/bin/env bash
# Snapshot canary OCR progress. Exit 2 if OCR_RENDERER_MISSING appears in NEW canary log.
set -euo pipefail
OUT=/tmp/stopship-ocr-diag
LOG=/opt/leadsniper-revalidate/logs/stopship-ocr-canary2.log
APP=/opt/leadsniper-revalidate/app
mkdir -p "$OUT"

# Fix probe import and run resolve in app cwd
cat > "$APP/scripts/_probe-pdftoppm-resolve.mjs" <<'EOF'
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { resolvePdftoppm, resetPdftoppmCache } from "../src/lib/sanita/ocr.ts";

async function main() {
  resetPdftoppmCache();
  const report = {
    pid: process.pid,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    cwd: process.cwd(),
    PATH: process.env.PATH,
    PDFTOPPM_PATH: process.env.PDFTOPPM_PATH ?? null,
    existsSync: fs.existsSync("/usr/bin/pdftoppm"),
    accessX_OK: (() => {
      try {
        fs.accessSync("/usr/bin/pdftoppm", fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    })(),
  };
  try {
    report.execAbs = String(
      execFileSync("/usr/bin/pdftoppm", ["-v"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (e) {
    report.execAbs = String(e.stderr || e.message || e);
  }
  try {
    report.execName = String(
      execFileSync("pdftoppm", ["-v"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (e) {
    report.execName = String(e.stderr || e.message || e);
  }
  report.resolved = await resolvePdftoppm();
  console.log(JSON.stringify(report, null, 2));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
EOF

cd "$APP"
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PDFTOPPM_PATH=/usr/bin/pdftoppm
export TESSDATA_PREFIX=/opt/leadsniper-revalidate/app/.tesseract-cache
npx tsx scripts/_probe-pdftoppm-resolve.mjs >"$OUT/c-worker-tsx.json" 2>&1 || true
echo "=== resolvePdftoppm ==="
cat "$OUT/c-worker-tsx.json"

echo "=== processes ==="
ps aux | grep -E 'production-revalidate-sanita-(v3|worker)' | grep -v grep || true

echo "=== worker PDFTOPPM_PATH ==="
for pid in $(ps -C node -o pid=); do
  cmd=$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null || true)
  case "$cmd" in
    *production-revalidate-sanita-worker.mjs*)
      echo "pid=$pid"
      tr '\0' '\n' < /proc/$pid/environ | grep -E '^(PDFTOPPM_PATH|PATH|TESSDATA_PREFIX)=' || true
      ;;
  esac
done

echo "=== OCR_RENDERER_MISSING in canary log ==="
OCR_CNT=$(grep -c OCR_RENDERER_MISSING "$LOG" 2>/dev/null || true)
OCR_CNT=${OCR_CNT:-0}
echo "count=$OCR_CNT"
if [ "$OCR_CNT" -gt 0 ] 2>/dev/null; then
  grep OCR_RENDERER_MISSING "$LOG" | tail -20 || true
fi

echo "=== frontiers ==="
python3 - <<'PY'
import json, sqlite3, glob, os
from pathlib import Path
ids = {
  "maione": "cmqkld5s700a8108eti0nofjv",
  "alba": "cmql46eia000ac9w78xh0rxdl",
}
base = Path("/opt/leadsniper-revalidate/app/data/revalidation/frontiers")
out = {}
for name, lid in ids.items():
  matches = sorted(base.glob(f"reval-p1-{lid}-*.sqlite"), key=lambda p: p.stat().st_mtime, reverse=True)
  if not matches:
    out[name] = {"missing": True}
    continue
  fp = matches[0]
  c = sqlite3.connect(str(fp))
  by = dict(c.execute("SELECT state, COUNT(*) FROM CrawlFrontierNode GROUP BY state").fetchall())
  run = c.execute(
    "SELECT totalDiscovered,totalRelevant,totalCompleted,totalPending,totalFailed,stopReason,state FROM CrawlRun ORDER BY rowid DESC LIMIT 1"
  ).fetchone()
  out[name] = {"path": str(fp), "byState": by, "run": list(run) if run else None, "mtime": fp.stat().st_mtime}
  c.close()
Path("/tmp/stopship-ocr-diag/canary-frontier-now.json").write_text(json.dumps(out, indent=2))
print(json.dumps(out, indent=2))
PY

echo "=== recent result files ==="
ls -lt /opt/leadsniper-revalidate/data/revalidation/results/*.json 2>/dev/null | head -8 || true
for f in $(ls -t /opt/leadsniper-revalidate/data/revalidation/results/*cmqkld5s700a8108eti0nofjv*.json 2>/dev/null | head -1); do
  echo "--- maione latest $f ---"
  python3 - <<PY
import json
from pathlib import Path
d=json.loads(Path("$f").read_text())
keys=["stopReason","outcome","status","commercialClass","ocr","rendererPath","pdfOcr","error"]
print({k:d.get(k) for k in keys if k in d or True})
# dig for OCR signals
s=json.dumps(d)
print("OCR_RENDERER_MISSING", "OCR_RENDERER_MISSING" in s)
print("rendererPath hits", [x for x in s.split('"rendererPath"')[:3]])
for k in ("stopReason","outcome","status","errorMessage","failureCode"):
  if k in d: print(k, d[k])
meta=d.get("meta") or d.get("diagnostics") or {}
if isinstance(meta, dict):
  for k in ("rendererPath","ocrRendererPath","stopReason","ocrStatus"):
    if k in meta: print("meta."+k, meta[k])
PY
done

echo "=== canary log tail ==="
tail -n 30 "$LOG"

if [ "$OCR_CNT" -gt 0 ] 2>/dev/null; then
  echo "STOP_SHIP_OCR_RENDERER_MISSING"
  exit 2
fi
echo MONITOR_OK
