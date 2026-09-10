#!/usr/bin/env bash
# Gira SUL SERVER OVH, una volta sola, su Ubuntu 24.04 appena creata.
#
#   ssh ubuntu@IP        (sulle immagini OVH l'utente e' ubuntu, non root)
#   sudo bash 01-provisiona.sh
#
# Prepara il sistema. Non installa il codice: quello e' 02-installa.sh.
# Cio' che protegge (swap, firewall) viene PRIMA di cio' che crea.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

if [[ "$(id -u)" != "0" ]]; then
  echo "Serve root: rilancia con  sudo bash $0"
  exit 1
fi

echo "=== 1/6  sistema ==="
apt-get update -qq
apt-get install -y -qq git curl ca-certificates build-essential python3 rsync ufw

echo
echo "=== 2/6  swap 4G ==="
# Il server vecchio (3,7 GB) veniva ucciso dall'OOM killer con Chromium a ~2,5 GB.
# Con 8 GB lo spazio c'e', ma lo swap e' la rete: un picco non deve uccidere un
# lead a meta' crawl, perche' poi riparte da capo.
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "  swap creato"
else
  echo "  swap gia' presente"
fi
free -h | sed 's/^/  /'

echo
echo "=== 3/6  firewall ==="
# La porta 3000 e' l'API del motore. Vercel non pubblica IP di uscita fissi,
# quindi resta aperta — com'era su Hetzner.
#
# ATTENZIONE, e' un limite dichiarato, non una svista: quella porta serve i
# dati dei lead in chiaro e senza autenticazione, a chiunque conosca l'IP.
# Chiuderla richiede un segreto condiviso fra proxy Vercel e motore: e' una
# modifica al codice di entrambi i lati, da fare a parte.
ufw allow 22/tcp   >/dev/null
ufw allow 3000/tcp >/dev/null
ufw --force enable >/dev/null
ufw status | sed 's/^/  /'

echo
echo "=== 4/6  Node.js 22 ==="
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
echo "  node $(node -v)   npm $(npm -v)"

echo
echo "=== 5/6  poppler (pdftoppm) — senza questo l'OCR non rasterizza ==="
apt-get install -y -qq poppler-utils
PPM="$(command -v pdftoppm || true)"
if [[ -z "$PPM" ]]; then
  echo "  FALLITO: pdftoppm assente. L'OCR non puo' funzionare."
  exit 1
fi
echo "  $PPM"
pdftoppm -v 2>&1 | head -1 | sed 's/^/  /'

echo
echo "=== 6/6  dipendenze di sistema per Chromium ==="
npx --yes playwright install-deps chromium 2>/dev/null || \
  echo "  (install-deps ha brontolato: 02-installa.sh riprova con le librerie apt)"

mkdir -p /opt/leadsniper /opt/leadsniper-revalidate
chown -R "${SUDO_USER:-ubuntu}:${SUDO_USER:-ubuntu}" /opt/leadsniper /opt/leadsniper-revalidate

echo
echo "PROVISION_OK"
echo
echo "Prossimo passo, dal portatile:"
echo "  bash deploy/ovh/00-prepara-pacchetto.sh"
echo "  scp /tmp/giorgio-motore/giorgio-motore.tgz /tmp/giorgio-motore/MANIFESTO.txt ubuntu@IP:/tmp/"
echo "poi qui:"
echo "  sudo bash 02-installa.sh"
