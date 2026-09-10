#!/usr/bin/env bash
# Gira SUL SERVER OVH, dopo 01-provisiona.sh e dopo lo scp del pacchetto.
#
#   sudo bash 02-installa.sh
#
# Installa il codice, costruisce, prepara la unit. NON avvia la rivalidazione:
# quella si accende a mano dopo che 03-verifica.sh e' verde.
set -euo pipefail

if [[ "$(id -u)" != "0" ]]; then
  echo "Serve root: rilancia con  sudo bash $0"
  exit 1
fi

UI=/opt/leadsniper
RV=/opt/leadsniper-revalidate
APP=$RV/app
PACCO=/tmp/giorgio-motore.tgz
MANIFESTO=/tmp/MANIFESTO.txt

echo "=== 1/9  il pacchetto e' arrivato? ==="
[[ -f "$PACCO" ]]     || { echo "  manca $PACCO"; exit 1; }
[[ -f "$MANIFESTO" ]] || { echo "  manca $MANIFESTO"; exit 1; }
ls -la "$PACCO" "$MANIFESTO" | sed 's/^/  /'
echo
sed -n '1,8p' "$MANIFESTO" | sed 's/^/  /'

echo
echo "=== 2/9  estrazione in $UI ==="
mkdir -p "$UI"
tar -xzf "$PACCO" -C "$UI"
grep -m1 '^# HEAD' "$MANIFESTO" | awk '{print $3}' > "$UI/RELEASE_SHA"
echo "  RELEASE_SHA = $(cat "$UI/RELEASE_SHA")"

echo
echo "=== 3/9  PROVA DI PROVENIENZA — le impronte combaciano? ==="
# Se un file che decide il verdetto non combacia, qui gira un motore diverso
# da quello collaudato sul portatile. Meglio fermarsi adesso che scoprirlo
# da una scheda sbagliata mostrata a un cliente.
cd "$UI"
if sha256sum -c --quiet <(grep -E '^[0-9a-f]{64} ' "$MANIFESTO"); then
  echo "  tutte le impronte combaciano"
else
  echo
  echo "  IMPRONTE DIVERSE — il codice arrivato non e' quello partito."
  echo "  Fermo qui. Rifai il pacchetto e ricopialo."
  exit 1
fi

echo
echo "=== 4/9  configurazione ==="
if [[ ! -f "$UI/.env" ]]; then
  cat > "$UI/.env" <<'FINE'
DATABASE_URL="file:./dev.db"
NODE_ENV=production
SCAN_ENGINE_LOCAL=1
OCR_ENABLED=1
POLICY_EXHAUSTIVE=1
SCAN_FAST=0
INSECURE_EXTERNAL_TLS=true
FINE
  echo "  scritto $UI/.env"
  echo "  >>> MANCA TAVILY_API_KEY: senza, la ricerca portali ASL non parte."
  echo "  >>> Aggiungila a mano:  echo 'TAVILY_API_KEY=...' >> $UI/.env"
else
  echo "  .env gia' presente, non lo tocco"
fi

echo
echo "=== 5/9  database ==="
# Il grafo commerciale non e' il motore: se non c'e' una copia da ripristinare,
# si parte da uno schema vuoto e i lead si riscoprono. Il motore funziona lo
# stesso; e' il catalogo che riparte da zero.
mkdir -p "$UI/prisma"
if [[ -f /tmp/giorgio-live-restore.db ]]; then
  install -m 0644 /tmp/giorgio-live-restore.db "$UI/prisma/dev.db"
  python3 - <<'PY'
import sqlite3
from pathlib import Path
p = Path("/opt/leadsniper/prisma/dev.db")
c = sqlite3.connect(f"file:{p.as_posix()}?mode=ro", uri=True)
n  = c.execute("select count(*) from Lead").fetchone()[0]
hc = c.execute("select count(*) from Lead where type='HEALTHCARE'").fetchone()[0]
print(f"  ripristinato: {n} lead, di cui {hc} sanita")
PY
else
  echo "  nessun /tmp/giorgio-live-restore.db — parto da schema vuoto"
  NEED_DB_PUSH=1
fi

echo
echo "=== 6/9  dipendenze (qualche minuto) ==="
cd "$UI"
npm ci
npx playwright install chromium
npx prisma generate
if [[ "${NEED_DB_PUSH:-0}" == "1" ]]; then
  npx prisma db push
fi

# La tessdata viaggia nel pacchetto. Se manca, si scarica — ma allora l'OCR
# dipende dalla rete al primo avvio, e non e' quello che vogliamo.
if [[ ! -f "$UI/.tesseract-cache/ita.traineddata" ]]; then
  echo "  tessdata italiana assente nel pacchetto: la scarico"
  npx tsx scripts/download-tessdata.mjs
fi

echo
echo "=== 7/9  costruzione UI ==="
npm run build

echo
echo "=== 8/9  UI sotto pm2 sulla porta 3000 ==="
npm install -g pm2 >/dev/null 2>&1 || true
pm2 delete leadsniper-ui >/dev/null 2>&1 || true
PORT=3000 SCAN_ENGINE_LOCAL=1 OCR_ENABLED=1 POLICY_EXHAUSTIVE=1 \
  DATABASE_URL="file:$UI/prisma/dev.db" \
  pm2 start npm --name leadsniper-ui --update-env -- start -- -H 0.0.0.0 -p 3000
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null | tail -n 1 | bash || true

echo
echo "=== 9/9  albero rivalidazione + unit (NON avviata) ==="
mkdir -p "$APP" \
  "$RV/data/revalidation/frontiers" \
  "$RV/data/revalidation/results" \
  "$RV/data/revalidation/locks" \
  "$RV/logs"

rsync -a --delete \
  --exclude=.next --exclude=node_modules --exclude=prisma/dev.db \
  "$UI/" "$APP/"
rm -rf "$APP/node_modules" "$APP/.next"
ln -s "$UI/node_modules" "$APP/node_modules"
ln -s "$UI/.next"        "$APP/.next"
cp "$UI/RELEASE_SHA" "$APP/RELEASE_SHA"
chmod +x "$APP/deploy/ovh/avvia-revalidate.sh"

# Il database ombra e' una COPIA: la rivalidazione non tocca il commerciale.
if [[ -f "$UI/prisma/dev.db" ]]; then
  install -m 0644 "$UI/prisma/dev.db" "$RV/shadow-revalidate.db"
fi

python3 - <<'PY'
import json
from datetime import datetime, timezone
from pathlib import Path
sha = Path("/opt/leadsniper-revalidate/app/RELEASE_SHA").read_text().strip()
cp = {
    "version": 3,
    "testedCodeSha": sha,
    "terminal": {},
    "retryQueue": {},
    "inProgress": {},
    "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
}
out = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
if out.exists():
    print("  checkpoint gia' presente, non lo sovrascrivo")
else:
    out.write_text(json.dumps(cp, indent=2), encoding="utf-8")
    print("  checkpoint vuoto creato per", sha)
PY

install -m 0644 "$APP/deploy/ovh/giorgio-revalidate.service" \
  /etc/systemd/system/giorgio-revalidate.service
# Nessun drop-in: se ne restano da installazioni vecchie, se ne vanno.
rm -rf /etc/systemd/system/giorgio-revalidate.service.d
systemctl daemon-reload
systemctl disable giorgio-revalidate >/dev/null 2>&1 || true

echo
echo "INSTALL_OK — la rivalidazione e' installata ma FERMA."
echo
echo "Adesso la prova, che e' l'unica cosa che conta:"
echo "  sudo bash $APP/deploy/ovh/03-verifica.sh"
