#!/usr/bin/env bash
# Batch produzione Hetzner — scrive su Supabase; Vercel legge lo stesso DB.
set -euo pipefail
cd "$(dirname "$0")/.."

export NODE_ENV=production
export POLICY_EXHAUSTIVE=1
export OCR_ENABLED=1
export SCAN_FAST=0
export SCAN_CONCURRENCY="${SCAN_CONCURRENCY:-8}"
export SCAN_ANALYSIS_CONCURRENCY="${SCAN_ANALYSIS_CONCURRENCY:-8}"

echo "=== LeadSniper PRODUCTION ×${SCAN_CONCURRENCY} → ${DATABASE_URL%%@*}@*** ==="
echo "POLICY_EXHAUSTIVE=1 OCR=1"

npx tsx scripts/download-tessdata.mjs 2>/dev/null || true
npx playwright install chromium --with-deps 2>/dev/null || npx playwright install chromium

npx tsx scripts/hetzner-full-pipeline.mjs Campania Veneto

echo "=== Certificazione ==="
npx tsx scripts/delivery-certification.mjs || true
npx tsx scripts/fix-delivery-blockers.mjs 2>/dev/null || true
npx tsx scripts/delivery-certification.mjs

echo "=== Fine ==="
