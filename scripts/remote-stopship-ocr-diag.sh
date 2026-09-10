#!/usr/bin/env bash
# OCR diagnosis: SSH vs systemd-run vs spawned worker child.
set -euo pipefail
OUT=/tmp/stopship-ocr-diag
APP=/opt/leadsniper-revalidate/app
mkdir -p "$OUT"

echo "=== A. SSH shell ==="
{
  echo "cwd=$(pwd)"
  echo "uid=$(id -u)"
  echo "PATH=$PATH"
  echo "PDFTOPPM_PATH=${PDFTOPPM_PATH:-unset}"
  which pdftoppm || true
  command -v pdftoppm || true
  test -x /usr/bin/pdftoppm && echo "exists_X_OK=yes" || echo "exists_X_OK=no"
  /usr/bin/pdftoppm -v 2>&1 | head -1 || true
  pdftoppm -v 2>&1 | head -1 || true
} | tee "$OUT/a-ssh.txt"

echo "=== B. systemd-run same unit env ==="
systemctl show giorgio-revalidate -p Environment -p WorkingDirectory -p User --no-pager | tee "$OUT/b-systemd-show.txt"
WORKDIR=$(systemctl show giorgio-revalidate -p WorkingDirectory --value)
systemd-run --wait --collect \
  -p WorkingDirectory="$WORKDIR" \
  -p Environment="PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  -p Environment="PDFTOPPM_PATH=/usr/bin/pdftoppm" \
  -p Environment="TESSDATA_PREFIX=/opt/leadsniper-revalidate/app/.tesseract-cache" \
  /bin/bash -c 'echo cwd=$(pwd); echo uid=$(id -u); echo PATH=$PATH; echo PDFTOPPM_PATH=$PDFTOPPM_PATH; which pdftoppm; test -x /usr/bin/pdftoppm && echo exists_X_OK=yes; /usr/bin/pdftoppm -v 2>&1 | head -1; pdftoppm -v 2>&1 | head -1' \
  | tee "$OUT/b-systemd-run.txt"

echo "=== C. worker-child resolve via tsx ==="
cd "$APP"
cat > /tmp/stopship-ocr-diag/probe-resolve.mjs <<'EOF'
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
    report.execAbs = String(execFileSync("/usr/bin/pdftoppm", ["-v"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (e) {
    report.execAbs = String(e.stderr || e.message || e);
  }
  try {
    report.execName = String(execFileSync("pdftoppm", ["-v"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
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
# copy into app for relative import
cp /tmp/stopship-ocr-diag/probe-resolve.mjs "$APP/scripts/_probe-pdftoppm-resolve.mjs"
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PDFTOPPM_PATH=/usr/bin/pdftoppm
export TESSDATA_PREFIX=/opt/leadsniper-revalidate/app/.tesseract-cache
export OCR_ENABLED=1
# First with OLD code if present, then after deploy
npx tsx scripts/_probe-pdftoppm-resolve.mjs | tee "$OUT/c-worker-tsx.json" || true
echo DIAG_OK
