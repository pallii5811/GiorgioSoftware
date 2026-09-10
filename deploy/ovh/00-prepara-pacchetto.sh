#!/usr/bin/env bash
# Gira SUL PORTATILE, dalla radice del progetto.
#
# Impacchetta il motore per il server nuovo e produce un manifesto di impronte,
# perche' il server possa dimostrare di aver ricevuto quello che e' partito.
#
# ATTENZIONE: impacchetta la COPIA DI LAVORO, non un commit. Al 10 settembre
# 2026 il motore finale e' per oltre dodicimila righe fuori da git; usare
# git archive spedirebbe un motore piu' vecchio.
set -euo pipefail

RADICE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$RADICE"

USCITA="${USCITA:-/tmp/giorgio-motore}"
mkdir -p "$USCITA"
PACCO="$USCITA/giorgio-motore.tgz"
MANIFESTO="$USCITA/MANIFESTO.txt"

echo "=== radice: $RADICE"
echo

# ---------------------------------------------------------------- provenienza
echo "=== provenienza del pacchetto ==="
HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || echo SCONOSCIUTO)"
RAMO="$(git branch --show-current 2>/dev/null || echo SCONOSCIUTO)"
SPORCHI="$(git status --porcelain 2>/dev/null | grep -c '^ M' || true)"
NUOVI="$(git status --porcelain 2>/dev/null | grep -c '^??' || true)"
echo "  ramo         : $RAMO"
echo "  HEAD         : $HEAD_SHA"
echo "  modificati   : $SPORCHI"
echo "  non tracciati: $NUOVI"

if [[ "$SPORCHI" != "0" || "$NUOVI" != "0" ]]; then
  echo
  echo "  >>> Il pacchetto contiene lavoro NON COMMITTATO."
  echo "  >>> Dopo questo trasloco, committarlo: e' l'unica copia esistente."
fi
echo

# ------------------------------------------------------------------ contenuto
# Esclusi: si ricostruiscono sul server (node_modules, .next) o non gli servono
# (dati di run, backup, staging morto, segreti — quelli si scrivono a mano).
echo "=== creo $PACCO ==="
tar -czf "$PACCO" \
  --exclude='./node_modules' \
  --exclude='./.next' \
  --exclude='./.git' \
  --exclude='./data' \
  --exclude='./backups' \
  --exclude='./tmp' \
  --exclude='./tmp-*' \
  --exclude='./.env' \
  --exclude='./.env.*' \
  --exclude='*.tgz' \
  --exclude='*.mojibake.bak' \
  --exclude='./prisma/dev.db' \
  ./src ./scripts ./prisma ./public ./tests ./deploy ./.tesseract-cache \
  ./package.json ./package-lock.json ./next.config.ts ./tsconfig.json \
  ./postcss.config.mjs ./components.json ./eslint.config.mjs \
  ./ita.traineddata 2>/dev/null || true

# data/comuni.json serve al motore (discovery territoriale): entra da solo.
tar -rzf "$PACCO" ./data/comuni.json 2>/dev/null \
  || tar -czf "$USCITA/comuni.tgz" ./data/comuni.json

ls -la "$PACCO"
echo

# ------------------------------------------------------------------ manifesto
# Le impronte dei file che decidono il verdetto commerciale. Se una di queste
# non combacia sul server, li' gira un motore diverso da questo.
echo "=== manifesto impronte ==="
{
  echo "# pacchetto motore Giorgio"
  echo "# creato    : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# ramo      : $RAMO"
  echo "# HEAD      : $HEAD_SHA"
  echo "# modificati: $SPORCHI    non tracciati: $NUOVI"
  echo "#"
  echo "# I file sotto decidono HOT / PUBLISHED / SELF_INSURANCE."
  echo "# Se un'impronta non combacia sul server, li' gira un altro motore."
  echo
  sha256sum \
    src/lib/sanita/detector.ts \
    src/lib/sanita/policy-verify.ts \
    src/lib/sanita/site-identity.ts \
    src/lib/sanita/ocr.ts \
    src/lib/sanita/crawler.ts \
    src/lib/sanita/crawl-slice-runner.ts \
    src/lib/sanita/frontier-store.ts \
    src/lib/sanita/finalize-verdict.ts \
    src/lib/sanita/can-emit-hot.ts \
    src/lib/sanita/can-emit-published.ts \
    scripts/production-revalidate-sanita-v3.mjs \
    scripts/production-revalidate-sanita-worker.mjs \
    scripts/revalidate-checkpoint-v3.mjs \
    scripts/preflight-ocr.mjs
} > "$MANIFESTO"

cat "$MANIFESTO"
echo
echo "=== pronto ==="
echo "  pacco     : $PACCO"
echo "  manifesto : $MANIFESTO"
echo
echo "Copia sul server (sostituisci UTENTE@IP):"
echo "  scp $PACCO $MANIFESTO UTENTE@IP:/tmp/"
