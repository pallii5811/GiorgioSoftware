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
# Prima si guarda cosa offre Ubuntu, poi si va da NodeSource.
#
# Misurato su Ubuntu 26.04 "resolute": NodeSource NON ha un repo per questo
# codename (deb.nodesource.com/.../dists/resolute/Release risponde 404), ma
# Ubuntu ha nodejs 22.22.1 nei propri archivi. Su 24.04 "noble" vale il
# contrario e NodeSource serve. Quindi si sceglie in base a cosa c'e',
# non in base a cosa ci si aspetta.
if ! command -v node >/dev/null 2>&1; then
  CANDIDATO="$(apt-cache policy nodejs 2>/dev/null | awk '/Candidate:/{print $2}')"
  MAGGIORE="$(echo "$CANDIDATO" | grep -oE '^[0-9]+' || echo 0)"
  echo "  nodejs negli archivi Ubuntu: ${CANDIDATO:-nessuno}"

  if [[ "${MAGGIORE:-0}" -ge 22 ]]; then
    echo "  va bene, uso quello"
    apt-get install -y -qq nodejs npm
  else
    echo "  troppo vecchio, provo NodeSource"
    if curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; then
      apt-get install -y -qq nodejs
    else
      echo "  FALLITO: ne' Ubuntu ne' NodeSource offrono Node 22 per questo sistema."
      echo "  Fermo qui invece di installare una versione a caso."
      exit 1
    fi
  fi
fi

VERSIONE_NODE="$(node -v 2>/dev/null || echo assente)"
echo "  node $VERSIONE_NODE   npm $(npm -v 2>/dev/null || echo assente)"
if [[ "$(echo "$VERSIONE_NODE" | grep -oE '[0-9]+' | head -1)" -lt 20 ]] 2>/dev/null; then
  echo "  FALLITO: Node troppo vecchio per Next 16."
  exit 1
fi

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
# playwright install-deps dichiara supporto fino a Ubuntu 24.04. Su una
# release piu' nuova puo' non riconoscere il sistema, e il modo in cui
# fallisce e' il problema: non installa niente e non lo grida. Chromium
# parte lo stesso e muore dopo, a meta' crawl, con un errore che parla di
# una libreria e non del fatto che nessuno l'ha installata.
#
# Quindi: si prova install-deps, e se non funziona si installano le librerie
# a mano. In ogni caso la prova vera NON e' qui: e' in 03-verifica.sh, dove
# Chromium deve davvero aprire una pagina.
#
# Nota su come NON scriverlo:  if npx ... | tail -3; then
# In una pipeline l'esito e' quello dell'ultimo comando, e tail riesce sempre.
# Scritto cosi', il ramo "ha funzionato" si prende anche quando install-deps
# e' morto — e su Ubuntu 26.04 "resolute" muore davvero, lasciando tutte e
# dodici le librerie di Chromium non installate. Misurato, non supposto.
# E nemmeno l'esito e' una prova. Su Ubuntu 26.04 install-deps esce ZERO e
# stampa "0 newly installed": riesce e non fa niente. L'unica cosa che conta e'
# se le librerie ci sono dopo, quindi si guarda quello.
LIBRERIE="libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2
          libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2
          libgbm1 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0
          libx11-6 libxcb1 libxext6"

# Si chiede a dpkg-query, non si spulcia l'uscita di dpkg -l.
#
# Costato un falso allarme su 19 librerie su 19: dpkg -l stampa il nome con
# l'architettura attaccata — "libnss3:amd64" — e un confronto che pretende uno
# spazio subito dopo il nome non aggancia mai niente. Il controllo dichiarava
# assente tutto cio' che era installato, e la conclusione sbagliata (che
# playwright install-deps non funzionasse) sembrava solida perche' il numero
# era netto: 19 su 19. Un numero netto non e' un numero giusto.
installata() {
  local nome
  for nome in "$1" "${1}t64"; do
    [[ "$(dpkg-query -W -f='${Status}' "$nome" 2>/dev/null)" == "install ok installed" ]] && return 0
  done
  return 1
}

mancanti() {
  local n=0 l
  for l in $LIBRERIE; do
    installata "$l" || n=$((n + 1))
  done
  echo "$n"
}

npx --yes playwright install-deps chromium > /tmp/install-deps.log 2>&1 || true
DOPO="$(mancanti)"

if [[ "$DOPO" == "0" ]]; then
  echo "  install-deps ha messo tutte le librerie"
else
  echo "  dopo install-deps ne mancano ancora $DOPO: le installo a mano"
  # Da Ubuntu 24.04 alcuni pacchetti hanno il suffisso t64 (transizione
  # time_t a 64 bit). Si prova il nome nuovo e poi quello vecchio.
  for base in libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
              libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
              libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
              libatspi2.0-0 libx11-6 libxcb1 libxext6 fonts-liberation; do
    apt-get install -y -qq "${base}t64" 2>/dev/null \
      || apt-get install -y -qq "$base" 2>/dev/null \
      || echo "    saltato: $base"
  done
fi

# Controprova finale. Non e' il verdetto — quello lo da' 03-verifica.sh aprendo
# davvero una pagina — ma se qui il numero non e' zero si sa subito dove
# guardare, invece di scoprirlo da un crawl che non vede nessun sito.
RESTANO="$(mancanti)"
if [[ "$RESTANO" == "0" ]]; then
  echo "  tutte le librerie di Chromium presenti"
else
  echo "  ATTENZIONE: $RESTANO librerie ancora assenti dopo l'installazione a mano."
  echo "  Chromium probabilmente non partira'. Nomi mancanti:"
  for l in $LIBRERIE; do
    installata "$l" || echo "    $l"
  done
fi

mkdir -p /opt/leadsniper /opt/leadsniper-revalidate
# Su OVH e Hetzner si entra come ubuntu e si usa sudo; su Scaleway si entra
# direttamente come root e l'utente ubuntu non esiste. Un chown a un utente
# inesistente fa fallire lo script all'ultima riga, dopo venti minuti di
# installazione. Si assegna a chi ha lanciato davvero, e se e' root si lascia
# a root.
PROPRIETARIO="${SUDO_USER:-root}"
id "$PROPRIETARIO" >/dev/null 2>&1 || PROPRIETARIO=root
chown -R "$PROPRIETARIO:$PROPRIETARIO" /opt/leadsniper /opt/leadsniper-revalidate
echo "  cartelle di /opt assegnate a $PROPRIETARIO"

echo
echo "PROVISION_OK"
echo
echo "Prossimo passo, dal portatile:"
echo "  bash deploy/ovh/00-prepara-pacchetto.sh"
echo "  scp /tmp/giorgio-motore/giorgio-motore.tgz /tmp/giorgio-motore/MANIFESTO.txt ubuntu@IP:/tmp/"
echo "poi qui:"
echo "  sudo bash 02-installa.sh"
