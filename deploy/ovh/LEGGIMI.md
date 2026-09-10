# Motore Giorgio su OVH — trasloco da Hetzner

Hetzner (`167.233.209.13`, prima `168.119.253.47`) è irraggiungibile dal
9 settembre 2026. Con lui è sparito l'output della rivalidazione. **Non è
sparito il motore**: i due `RELEASE_SHA` che il server aveva stampato
(`6d006442`, `e96994fc`) sono antenati di `HEAD`, e le sette patch che
`docs/HANDOFF-CODEX-PERFECT-SCAN.md` dichiara applicate via scp sono tutte
presenti nel tree locale.

## Cosa NON si può ricostruire, e come si rimedia

Il servizio su Hetzner girava con **otto drop-in systemd** sovrapposti, che
riscrivevano le stesse variabili con valori diversi:

| variabile | valori visti nei drop-in |
|---|---|
| `TOTAL_WORKERS` | 1, 2 |
| `CRAWL_HTML_URL_CAP` | 40, 100 |
| `REVALIDATE_LEAD_WALL_MS` | 1.800.000, 2.700.000, 3.300.000 |

Quale combinazione fosse attiva alla fine **non è più sapibile**: l'unico
dump catturato è `data/k3-stopship/systemd-environment.json`, del 22 luglio.

Rimedio: qui c'è **una sola unit**, senza drop-in. Gli invarianti sono quelli
dichiarati in `docs/ops/giorgio-revalidate.md`; la taratura è rifatta per una
macchina da 8 GB. Un valore si cambia in un posto solo, e si vede.

## La macchina

Dal handoff, sezione B6: *«giorgio-revalidate va in oom-kill (Chromium peak
~2.5G)»*, su una macchina da 3,7 GB. Quindi 8 GB è il minimo, non il comodo.

| | |
|---|---|
| RAM | **8 GB** |
| vCPU | 4 |
| Disco | 80 GB NVMe |
| OS | Ubuntu 24.04 LTS |
| Rete | **IP fisso** — Vercel deve puntarci |

Occupazione prevista: repo 455 MB, `node_modules` ~1 GB (condiviso fra i due
alberi via link), Chromium ~500 MB, tessdata 39 MB.

## Ordine delle operazioni

Ciò che protegge viene prima di ciò che crea. Ogni passo si verifica prima
del successivo: un `Success` non è una prova.

```
sul portatile   00-prepara-pacchetto.sh    crea il .tgz e il manifesto
sul server      01-provisiona.sh           sistema, Node, poppler, firewall
sul portatile   scp del pacchetto
sul server      02-installa.sh             codice, dipendenze, build, unit
sul server      03-verifica.sh             LA PROVA — deve uscire 0
```

**Il motore non parte da solo.** `02-installa.sh` lascia
`giorgio-revalidate` disabilitato e `APPLY_LIVE=0`. La rivalidazione degli
877 si accende a mano, dopo che `03-verifica.sh` è verde.

## Il pacchetto viene dal TREE, non da un commit

Al 10 settembre 2026 il motore finale è per **12.808 righe fuori da git**.
`00-prepara-pacchetto.sh` impacchetta quindi la copia di lavoro, non
`git archive`, e lo dice a voce alta. Finché quelle righe non sono
committate, questa cartella e il portatile sono l'unica copia esistente —
la stessa condizione che ha reso costosa la perdita di Hetzner.

## Lo scambio su Vercel

L'IP sta in **due** posti. Cambiarne uno solo non basta:

| dove | cosa |
|---|---|
| `src/lib/sanita/scan-engine-url.ts` | costante `HETZNER_SCAN_ENGINE`, usata come ripiego |
| variabile Vercel | `SCAN_ENGINE_URL` |

E il ciclo di proxy in `src/app/api/sanita/route.ts` prova i due indirizzi
**senza timeout sul fetch**: con un motore morto ogni richiesta paga
l'attesa intera (misurati 16 s prima del 500 del 9 settembre).
