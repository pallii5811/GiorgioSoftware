#!/usr/bin/env bash
# Avvia UI Next.js in produzione (dopo build).
set -euo pipefail
cd "$(dirname "$0")/.."
export NODE_ENV=production
export POLICY_EXHAUSTIVE=1
export OCR_ENABLED=1

npm run build
exec npm run start -- -H 0.0.0.0 -p "${PORT:-3000}"
