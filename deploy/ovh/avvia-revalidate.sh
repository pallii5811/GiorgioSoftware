#!/usr/bin/env bash
# Lanciato da giorgio-revalidate.service. Non serve chiamarlo a mano.
#
# Esiste per due ragioni:
#
# 1. flock: un solo processo padre alla volta. Due orchestratori sullo stesso
#    checkpoint si sovrascrivono a vicenda e il conteggio dei terminali smette
#    di tornare.
#
# 2. Le sostituzioni di shell dentro ExecStart= sono una trappola: systemd
#    espande $VAR a modo suo e $(comando) non lo espande affatto. Su Hetzner
#    la unit conteneva  bash -c 'export GIT_HEAD=$(cat RELEASE_SHA); ...'
#    e funzionava per caso. Qui la shell e' vera, quindi si comporta da shell.
set -euo pipefail

APP=/opt/leadsniper-revalidate/app
LOCK=/opt/leadsniper-revalidate/revalidate.parent.lock

cd "$APP"

if [[ ! -f RELEASE_SHA ]]; then
  echo "RELEASE_SHA assente in $APP — non so quale motore sto avviando. Fermo."
  exit 1
fi

GIT_HEAD="$(cat RELEASE_SHA)"
export GIT_HEAD
export RELEASE_SHA="$GIT_HEAD"

echo "=== avvio rivalidazione ==="
echo "  motore   : $GIT_HEAD"
echo "  data     : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "  APPLY_LIVE=${APPLY_LIVE:-non impostato}  (0 = non tocca il DB commerciale)"

exec /usr/bin/flock -n "$LOCK" /usr/bin/npx tsx scripts/production-revalidate-sanita-v3.mjs
