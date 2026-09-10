#!/usr/bin/env bash
set -euo pipefail
# Kill ALL revalidate workers; leave a single clean process.
pkill -f 'production-revalidate-sanita-v2' 2>/dev/null || true
sleep 3
pkill -9 -f 'production-revalidate-sanita-v2' 2>/dev/null || true
sleep 1
rm -f /opt/leadsniper-revalidate/revalidate.pid
echo "remaining:"
pgrep -af 'production-revalidate' || echo none

echo "=== tessdata ==="
find /usr -name 'ita.traineddata' 2>/dev/null | head
find /opt -name 'ita.traineddata' 2>/dev/null | head
ls -la /usr/share/tesseract-ocr/*/tessdata 2>/dev/null || true
ls -la /usr/share/tessdata 2>/dev/null || true
which tesseract; tesseract --version 2>&1 | head -3
which pdftoppm; pdftoppm -v 2>&1 | head -1
env | grep -E 'TESSDATA|OCR|PDFTOPPM|SCAN_' | sed 's/=.*/=***/' || true

# Prefer blue live env for OCR paths
if [ -f /opt/leadsniper/.env ]; then
  grep -E '^(TESSDATA|OCR|PDFTOPPM|SCAN_|ACTIONABLE)' /opt/leadsniper/.env | sed 's/=.*/=***/' || true
fi
if [ -f /opt/leadsniper-green/.env ]; then
  grep -E '^(TESSDATA|OCR|PDFTOPPM|SCAN_|ACTIONABLE)' /opt/leadsniper-green/.env | sed 's/=.*/=***/' || true
fi
