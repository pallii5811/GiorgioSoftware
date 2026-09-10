#!/usr/bin/env bash
# LA PROVA. Gira SUL SERVER, dopo 02-installa.sh.
#
#   sudo bash 03-verifica.sh
#
# Sta in un file a parte, e non in coda all'installazione, per una ragione
# pagata: una verifica in fondo a uno script lungo non gira se lo script si
# ferma prima di arrivarci, e la sua assenza non si vede. Qui si lancia da
# sola, si guarda l'uscita, e il codice di uscita e' 1 se qualcosa non torna.
#
# Un "Success" non e' una prova. Una tabella di PASS lo e'.
set -uo pipefail

UI=/opt/leadsniper
RV=/opt/leadsniper-revalidate
APP=$RV/app

falliti=0
esito() {
  if [[ "$1" == "0" ]]; then
    printf "  PASS  %s\n" "$2"
  else
    falliti=$((falliti + 1))
    printf "  FAIL  %s\n" "$2"
  fi
}

echo "=========================================================="
echo " verifica motore Giorgio — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "=========================================================="
echo

echo "--- 1. il rasterizzatore PDF ---"
PPM="$(command -v pdftoppm || true)"
[[ -n "$PPM" ]]; esito $? "pdftoppm presente ($PPM)"
pdftoppm -v >/dev/null 2>&1; esito $? "pdftoppm eseguibile"

echo
echo "--- 2. i dizionari OCR ---"
for t in ita eng; do
  [[ -f "$APP/.tesseract-cache/$t.traineddata" ]]
  esito $? "tessdata $t"
done

echo
echo "--- 3. preflight OCR (rasterizza un PDF vero e lo legge) ---"
( cd "$APP" && npx tsx scripts/preflight-ocr.mjs >/tmp/preflight-ocr.out 2>&1 )
esito $? "preflight:ocr esce 0"
tail -3 /tmp/preflight-ocr.out | sed 's/^/        /'

echo
echo "--- 4. controllo di controllo (deve FALLIRE apposta) ---"
# Un controllo che non ha mai fallito non e' un controllo. Questo prende una
# regex volutamente storpiata: se la dichiara sana, allora il controllo del
# punto 5 non vale niente e va sistemato prima di fidarsene.
python3 - <<'PY'
import sys
rotta = "responsabilit[aÃ ]"           # come si era corrotta davvero
sana  = "responsabilit[aà]"
ok = ("à" not in rotta) and ("à" in sana)
print("  PASS  il controllo accenti riconosce una regex storpiata" if ok
      else "  FAIL  il controllo accenti NON riconosce una regex storpiata")
sys.exit(0 if ok else 1)
PY
esito $? "prova a vuoto del controllo accenti"

echo
echo "--- 5. lettere accentate nelle regex del verdetto ---"
python3 - <<'PY'
import sys
from pathlib import Path
ROTTE = [b"\xc3\x83\xc2\xa0", b"\xc3\x83\xc2\xa8", b"\xc3\x83\xc2\xa9",
         b"\xc3\x83\xc2\xac", b"\xc3\x83\xc2\xb2", b"\xc3\x83\xc2\xb9"]
base = Path("/opt/leadsniper-revalidate/app")
guasti = 0
for rel in ["src/lib/sanita/detector.ts", "src/lib/sanita/policy-verify.ts",
            "src/lib/sanita/site-identity.ts", "src/lib/sanita/self-insurance.ts"]:
    p = base / rel
    if not p.exists():
        continue
    b = p.read_bytes()
    n = sum(b.count(r) for r in ROTTE)
    if n:
        guasti += n
        print(f"        {rel}: {n} accenti ricodificati due volte")
print(f"  {'PASS' if guasti == 0 else 'FAIL'}  nessuna regex con accento storpiato")
sys.exit(0 if guasti == 0 else 1)
PY
esito $? "regex del verdetto integre"

echo
echo "--- 6. suite di test del motore ---"
( cd "$APP" && npx tsx scripts/test-suite.mjs >/tmp/test-suite.out 2>&1 )
esito $? "test-suite esce 0"
grep -E "TUTTI I TEST PASSATI|ERRORI" /tmp/test-suite.out | tail -2 | sed 's/^/        /'

echo
echo "--- 7. la UI risponde con dati veri ---"
CODICE="$(curl -s -m 30 -o /tmp/api.json -w '%{http_code}' \
  'http://127.0.0.1:3000/api/sanita?region=Campania&includePending=1')"
[[ "$CODICE" == "200" ]]; esito $? "GET /api/sanita da locale -> $CODICE"
python3 - <<'PY'
import json, sys
from pathlib import Path
p = Path("/tmp/api.json")
if not p.exists() or p.stat().st_size == 0:
    print("        risposta vuota"); sys.exit(1)
j = json.loads(p.read_text())
leads = j.get("leads", j)
if isinstance(leads, dict):
    leads = leads.get("data") or []
print(f"        lead restituiti: {len(leads)}")
sys.exit(0 if isinstance(leads, list) else 1)
PY
esito $? "il corpo e' una lista di lead"

echo
echo "--- 8. la porta 3000 e' raggiungibile da fuori ---"
IP="$(curl -s -m 10 https://api.ipify.org || echo '')"
if [[ -n "$IP" ]]; then
  FUORI="$(curl -s -m 20 -o /dev/null -w '%{http_code}' "http://$IP:3000/api/sanita?region=Campania" || echo 000)"
  [[ "$FUORI" == "200" ]]; esito $? "GET http://$IP:3000 -> $FUORI  (Vercel deve puntare qui)"
  echo "        IP da mettere su Vercel: $IP"
else
  esito 1 "non ho potuto scoprire l'IP pubblico"
fi

echo
echo "--- 9. la rivalidazione non tocca il database commerciale ---"
systemctl show giorgio-revalidate -p Environment --no-pager 2>/dev/null \
  | tr ' ' '\n' | grep -q 'APPLY_LIVE=0'
esito $? "APPLY_LIVE=0 nella unit"
systemctl show giorgio-revalidate -p Environment --no-pager 2>/dev/null \
  | tr ' ' '\n' | grep -q 'DISABLE_LIVE_DB=true'
esito $? "DISABLE_LIVE_DB=true nella unit"
[[ ! -d /etc/systemd/system/giorgio-revalidate.service.d ]]
esito $? "nessun drop-in che sovrascriva la unit"

echo
echo "--- 10. il motore installato e' quello collaudato ---"
if [[ -f /tmp/MANIFESTO.txt ]]; then
  ( cd "$UI" && sha256sum -c --quiet <(grep -E '^[0-9a-f]{64} ' /tmp/MANIFESTO.txt) >/dev/null 2>&1 )
  esito $? "impronte dei file del verdetto invariate"
else
  esito 1 "MANIFESTO.txt assente: non posso provare la provenienza"
fi
echo "        RELEASE_SHA: $(cat "$APP/RELEASE_SHA" 2>/dev/null || echo assente)"

echo
echo "=========================================================="
if [[ "$falliti" == "0" ]]; then
  echo " VERIFICA SUPERATA — 0 fallimenti"
  echo
  echo " Il motore e' pronto e FERMO. Per accendere la rivalidazione:"
  echo "   sudo systemctl enable --now giorgio-revalidate"
  echo "   journalctl -u giorgio-revalidate -f"
  echo
  echo " Prima di accenderla, punta Vercel a questo server (due posti):"
  echo "   1. src/lib/sanita/scan-engine-url.ts  ->  costante"
  echo "   2. variabile SCAN_ENGINE_URL su Vercel"
  exit 0
else
  echo " VERIFICA FALLITA — $falliti controlli non passati"
  echo " Non accendere la rivalidazione finche' non sono zero."
  exit 1
fi
