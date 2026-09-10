#!/bin/bash
set -uo pipefail
echo "===1 APP PATHS==="
ls -la /opt/leadsniper /opt/leadsniper-revalidate /opt/leadsniper-revalidate/app 2>&1 | head -40
echo "UI_DIR=/opt/leadsniper"
echo "REVAL_APP=/opt/leadsniper-revalidate/app"

echo "===2-5 GIT / RELEASE==="
for D in /opt/leadsniper /opt/leadsniper-revalidate/app; do
  echo "--- $D ---"
  if [[ -d "$D/.git" ]]; then
    git -C "$D" remote -v 2>&1 || true
    git -C "$D" branch --show-current 2>&1 || true
    git -C "$D" rev-parse HEAD 2>&1 || true
    git -C "$D" status -sb 2>&1 | head -5 || true
  else
    echo "NO_GIT_DIR"
  fi
  echo -n "RELEASE_SHA_FILE="; cat "$D/RELEASE_SHA" 2>/dev/null || echo MISSING
done

echo "===6-8 SYSTEMD==="
systemctl cat giorgio-revalidate 2>&1 || echo "NO_UNIT_giorgio-revalidate"
systemctl list-units --type=service --all 2>/dev/null | grep -iE 'giorgio|sanita|leadsniper|revalid' || true
echo "--- show ---"
systemctl show giorgio-revalidate -p FragmentPath -p WorkingDirectory -p ExecStart -p ActiveState -p MainPID 2>&1 || true
echo "--- pm2 ---"
pm2 describe leadsniper-ui 2>/dev/null | head -35 || true
echo -n "PM2_CWD="; pm2 jlist 2>/dev/null | python3 -c 'import sys,json; a=json.load(sys.stdin); print(a[0]["pm2_env"]["pm_cwd"] if a else "none")' 2>/dev/null || echo none

echo "===9 FEATURE MARKERS==="
APP=/opt/leadsniper-revalidate/app
UI=/opt/leadsniper
for root in "$UI" "$APP"; do
  echo "--- markers in $root ---"
  for pat in SELF_INSURANCE_VERIFIED self-insurance.ts resume_boost prepareFrontierForRetry FORCE_FRESH OCR_JOB_TIMEOUT production-revalidate-sanita-v3; do
    n=$(grep -Rsl --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.js' "$pat" "$root" 2>/dev/null | head -3 | wc -l)
    echo "  $pat hits_files~$n"
  done
  ls "$root/src/lib/sanita/self-insurance.ts" 2>/dev/null && echo "  self-insurance.ts EXISTS" || echo "  self-insurance.ts MISSING"
  ls "$root/scripts/production-revalidate-sanita-v3.mjs" 2>/dev/null && echo "  v3.mjs EXISTS" || echo "  v3.mjs MISSING"
  ls "$root/scripts/test-stop-ship.mjs" "$root/scripts/test-stopship-no-tech-terminal.mjs" 2>/dev/null || true
  # corpus-ish
  find "$root" -maxdepth 3 -iname '*corpus*' 2>/dev/null | head -10
  find "$root/data" -maxdepth 3 -iname '*k3*' 2>/dev/null | head -10
done

echo "=== OCR CONFIG ==="
command -v pdftoppm; ls -la /opt/leadsniper/.tesseract-cache 2>/dev/null | head -5
ls -la /opt/leadsniper-revalidate/app/.tesseract-cache 2>/dev/null | head -5
grep -E 'PDFTOPPM|TESSDATA|OCR_|PLAYWRIGHT_CHROMIUM' /opt/leadsniper/.env 2>/dev/null | sed 's/=.*/=***/' || true
systemctl show giorgio-revalidate -p Environment 2>/dev/null | tr ' ' '\n' | grep -E 'PDFTOPPM|TESSDATA|OCR_|PLAYWRIGHT|DATABASE|SCAN_|POLICY|REVALIDATE' || true

echo "=== DB 877 ==="
python3 - <<'PY'
import sqlite3, hashlib
from pathlib import Path
for p in ["/opt/leadsniper/prisma/dev.db","/opt/leadsniper-revalidate/shadow-revalidate.db"]:
  path=Path(p)
  if not path.exists():
    print(p,"MISSING"); continue
  h=hashlib.sha256(path.read_bytes()).hexdigest()
  c=sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
  n=c.execute("select count(*) from Lead").fetchone()[0]
  hc=c.execute("select count(*) from Lead where type='HEALTHCARE'").fetchone()[0]
  print({"path":p,"sha256":h,"leads":n,"healthcare":hc})
PY

echo "=== HOW CODE WAS INSTALLED ==="
ls -la /tmp/leadsniper-code.tgz /tmp/giorgio-live-restore.db 2>/dev/null || true
stat /opt/leadsniper/package.json /opt/leadsniper/RELEASE_SHA 2>/dev/null | head -20
