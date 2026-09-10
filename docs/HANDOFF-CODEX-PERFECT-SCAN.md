# HANDOFF CODEX — Scan Sanità: obiettivo “perfezione” NON raggiunto

**Data:** 2026-07-26  
**Per:** Codex + GPT-5.6  
**Da:** Cursor (Composer) — handoff esplicito: l’agente precedente **non ha raggiunto** l’obiettivo.  
**Repo:** `windsurf-project-20`  
**Server:** Hetzner `167.233.209.13`  
**Servizio:** `giorgio-revalidate`  
**App motore:** `/opt/leadsniper-revalidate/app`  
**Checkpoint:** `/opt/leadsniper-revalidate/data/revalidation/checkpoint.json`  
**Results:** `/opt/leadsniper-revalidate/data/revalidation/results/`  
**Live DB (READ-ONLY in questa run):** `/opt/leadsniper/prisma/dev.db`  
**APPLY_LIVE:** `0` / `DISABLE_LIVE_DB=true` — shadow only  
**RELEASE_SHA sul server (al handoff):** `6d0064423ba3fceed23892156387efaca8af5816`  
**Nota:** patch runtime su Hetzner **non sempre** allineate a git locale / remote (deploy spesso via scp).

---

## 1. Obiettivo prodotto (autoritativo, non negoziabile)

L’utente vuole **solo**:

1. **Ogni lead** del pool (~877) scansionato **completamente** (HTML + PDF + script/JSON rilevanti del sito).
2. **Nessun retry residuo** a fine run (coda vuota).
3. **Nessun falso HOT** — HOT solo se crawl esaustivo e **nessuna** polizza/autoassicurazione trovata.
4. **Nessun falso PUBLISHED**.
5. **Nessun “Da controllare” / `REVIEW_HUMAN`** salvo sito **davvero irraggiungibile** (DNS/host morto), non per incompleti, identity flaky, dual disagree, OCR debole, ecc.
6. Se c’è polizza (anche **solo HTML in home/footer**, senza PDF) → **PUBLISHED** (o SI se autoassicurazione esplicita), **mai HOT**.
7. Qualità chirurgica: diff minimo; **non toccare** `crawler.ts` / `policy-verify.ts` / `detector.ts` **salvo necessità esplicita** — ma l’obiettivo qualità **prevale** se quei file sono la root cause (già toccati in emergenza: detector + policy-verify + site-identity).

**Stato al handoff: OBIETTIVO NON RAGGIUNTO.**

---

## 2. Snapshot numerico (2026-07-26 ~17:20 UTC)

| Metrica | Valore |
|---|---|
| Terminali | ~305 / ~877 |
| HOT_VERIFIED | ~238 |
| PUBLISHED_* (tutti) | ~8 (1 CURRENT + 3 DATE_UNKNOWN + 3 EXPIRED + …) |
| SELF_INSURANCE | ~3 |
| REVIEW_HUMAN | ~49 |
| TECHNICAL_BLOCKED | ~7 |
| Retry queue | ~572 |
| In progress | 1 |
| Legacy PUB in live DB | **120** |
| Di cui rivalidati PUB in shadow | **1 EXPIRED** (+ 2 SI, non “PUB”) |
| Legacy PUB ancora in retry | **~105** |
| Legacy PUB **regrediti a HOT** | **12** |

Quindi: **non** “122 published ora pochi perché finiti” — **quasi tutti i published legacy non sono ancora certificati nella run 877**, e 12 sono diventati HOT (regressioni da verificare a fondo).

---

## 3. Criticità BLOCCANTI (ordine di priorità)

### B1 — Coda retry permanente (~570+)

**Non è “lavoro residuo sano”.** È un sistema che **non chiude**.

Famiglie tipiche (approx):

| Famiglia | ~N | Problema |
|---|---|---|
| `RETRY_PENDING` generico | ~215 | Slice/incompleto/wall — riparte ma non terminalizza |
| `IDENTITY_*` | ~187 | Falsi “sito errato” → loop / riprese inutili |
| `REVIEW_HUMAN` in retry | ~52 | Review non dovrebbero essere “coda operativa” |
| `PUBLISHED_*` / `SELF_INSURANCE_*` in retry | ~40+ | Lead già “commerciali” ancora in coda (stato inconsistente) |
| `CRAWL_CAP` | ~16 | Cap HTML/tempo → incompleto trattato come retry |
| `RELEVANT_URL_FAILED_EXHAUSTED` | ~14 | URL rilevanti falliti |
| `PDF_UNPROCESSED` | ~10 | PDF trovati ma non letti |
| `SITEMAP_UNRESOLVED` | ~10 | Sitemap blocca chiusura HOT |
| `IN_PROGRESS_INTERRUPTED` / OOM | ~8 | Kill memoria |

**Cosa manca:** policy di chiusura deterministica: incompleto → resume fino a `crawlComplete`; solo irraggiungibile → REVIEW/TECH; mai lasciare PUB/SI/HOT “finti” in retry.

### B2 — IDENTITY_MISMATCH gonfia tutto (~187)

Gate in `src/lib/sanita/site-identity.ts`:

- Fallimenti tipici: **NOME_ASSENTE** (~122), **CITTA_DIVERSA** (~38), parcheggiati/hotel.
- **~83%** degli identity retry hanno **host brand-match** col nome (sito probabilmente giusto).
- Caso reale: `Casa flavia` / `flavia.com` — nome e brand OK, ma fallisce su **“città sul sito (verona) ≠ Giugliano”** (falso mismatch multi-sede / testo spurio).

Patch parziale deployata su Hetzner (`brandHostHealthSite`): dominio first-party + corpus sanitario → non bloccare solo per nome/città. **Self-check unit passa**, ma **sulla coda reale i 187 non sono scesi** — o la patch non copre `CITTA_DIVERSA` quando `cityOnSite` trova un’altra città, o i lead non sono stati ri-eseguiti con codice nuovo / ripartono da frontier sbagliato.

**Cosa manca:**

1. Fix completo di `validateSiteIdentity` per multi-sede (non usare “verona” random nel corpus come proof di omonimia).
2. URL palesemente sbagliati (`delta.com`, `trieste.com`, `linktr.ee`, domini parcheggiati) → **REVIEW/URL errato**, non loop infinito.
3. Requeue identity con **resume** (non fresh) — patch `pickRetryStrategy` su server: IDENTITY → resume/resume_boost. **Verificare che sia ancora attiva** in `scripts/revalidate-checkpoint-v3.mjs`.
4. Dopo fix: **forceDue** su tutti gli IDENTITY e misurare drenaggio in 30–60 min.

### B3 — Falsi HOT (già dimostrati, rischio residuo alto)

Esempio chiuso in audit:

- **IATREION**: polizza n. **747217409** in home HTML → era HOT (`policyFound=false`, `PDF letti 0/0`, ma evidence citava già la pagina polizza).
- **Galdiero**: Reale Mutua **2022/03/2475660** in footer → stesso schema.

Root cause detector (`analyzePolicy`):

- `policyFound` richiedeva compagnia+massimale/scadenza; numero+RC non bastava.
- Pattern non catturava `Polizza YYYY/MM/...` senza “n.”.

Patch deployata: `htmlPolicyNumberRc` + pattern YYYY/MM + in `policy-verify` `policyNumber && hasRcContext` → PUBLISHED.  
Self-check: `scripts/check-html-home-policy.mjs` (su server).  
I due lead forzati a `PUBLISHED_DATE_UNKNOWN` in shadow.

**Cosa manca:**

- Audit sistematico di **tutti** gli HOT attuali (238) con probe HTML forte (non solo homepage soft).
- Gate soft-block: se evidence contiene `fonte polizza` URL ma `policyFound=false` / `PDF letti 0/0` → **mai HOT**, retry o REVIEW.
- Non dichiarare “0 falsi HOT” senza campione umano + probe.

### B4 — Published legacy ~120 vs shadow ~8

| Stato legacy PUB (live) | N |
|---|---|
| Ancora in retry | ~105 |
| Terminal HOT (regressione) | 12 |
| Terminal SI | 2 |
| Terminal PUB_EXPIRED | 1 |

**Perché “pochi published”:** non perché la run li abbia invalidati tutti — **non li ha ancora richiusi come PUB**. La UI/shadow mostra i nuovi terminali; i 120 legacy restano in live DB ma la rivalidazione 877 non li ha riprodotti.

I 12 HOT da ex-PUB (probe homepage): **0** con segnale forte HTML immediato; 6 con soli PDF istituzionali; 6 no signal. **Non** sono stati forzati di nuovo a PUB — richiedono crawl PDF/OCR/trasparenza profonda (es. Policlinico Abano AmTrust RCH…, Aias Nola SI, ecc.).

**Cosa manca:**

1. Priority queue: **prima tutti i 120 legacy PUB**, fino a terminal PUB/SI/EXPIRED o prova di assenza.
2. Per i 12 HOT: deep requeue + OCR PDF legacy sources; se polizza ancora lì → PUB; se rimossa davvero → HOT solo con crawl esaustivo documentato.
3. Baseline immutabile 117/120: file spesso **assente** sul server nuovo; usare CSV/`[V:PUB]` live come proxy e documentarlo.

### B5 — REVIEW_HUMAN (~49) troppo largo

Regola utente: REVIEW solo se **irraggiungibile**.  
Oggi REVIEW include dual disagree, identity, incompleti reclassified, wrong host audit, ecc.

**Cosa manca:** riclassificare: incompleti → retry; wrong URL chiaro → REVIEW; unreachable → REVIEW/TECH; dual HOT → **non** REVIEW permanente senza regola prodotto esplicita.

### B6 — Infrastruttura: OOM / 3.7GB RAM / concurrency 1

- `giorgio-revalidate` va in **oom-kill** (Chromium peak ~2.5G).
- `REVALIDATE_CONCURRENCY=1`, wall ~3.3M ms → un lead “hog” blocca ore l’intera coda.
- Esempio: lead identity ripartiva con `resumed:false` anche con strategy resume_boost; frontier giganti di nodi `low/EXCLUDED`.

**Cosa manca:** swap o macchina più grande; hard cap nodi low; kill/skip lead hog dopo N minuti con resume schedulato; logging stdout utile (ora journal quasi vuoto oltre systemd kill).

---

## 4. Patch già fatte (da verificare / consolidare in git)

| Area | File | Cosa |
|---|---|---|
| HTML polizza → policyFound | `src/lib/sanita/detector.ts` | `htmlPolicyNumberRc`, pattern `Polizza YYYY/MM/...` |
| HTML polizza → PUBLISHED | `src/lib/sanita/policy-verify.ts` | `if (policyNumber && hasRcContext) return true` |
| Identity brand host | `src/lib/sanita/site-identity.ts` | `brandHostHealthSite` |
| No fresh su IDENTITY | `scripts/revalidate-checkpoint-v3.mjs` | IDENTITY → resume / resume_boost |
| UI HOT blend | `src/components/sanita-leads.tsx` | non mescolare policy live su HOT (push a volte fallito) |
| Chromium path | `playwright-launch.ts` + systemd | binary snap reale, non launcher |
| Self-check | `scripts/check-html-home-policy.mjs`, `scripts/check-identity-brand-host.mjs`, `scripts/check-retry-strategy.mjs` | sul server |

**Attenzione:** tree locale può avere encoding corrotto su `detector.ts` (PowerShell); sorgente buona = **Hetzner** o `git show HEAD`.

---

## 5. Cosa NON è fatto (checklist obiettivo)

- [ ] Retry queue = 0
- [ ] Tutti i ~877 in terminale commerciale o TECH solo se irraggiungibile
- [ ] REVIEW solo irraggiungibili veri
- [ ] 0 falsi HOT (audit + gate automatico)
- [ ] ~120 legacy PUB rivalidati (non 8)
- [ ] 12 regressioni HOT da PUB risolte caso per caso
- [ ] IDENTITY non blocca siti first-party corretti
- [ ] Motore stabile senza OOM loop
- [ ] Prova end-to-end documentata (conteggi + sample lead: Villa Dei Pini SI, Villa dei Fiori PUB, Sant'Anna Medical HOT se ancora valido)
- [ ] Commit/push allineati a ciò che gira su Hetzner

---

## 6. Piano consigliato per Codex (ordine stretto)

1. **Freeze claim:** non dire “ok/perfetto” senza prova.
2. **Misura:** riesegui snapshot checkpoint + breakdown retry + legacy PUB map.
3. **Chiudi IDENTITY (B2):** fix `CITTA_DIVERSA` spurio; park URL junk → REVIEW; forceDue 187; misura Δ retry 1h.
4. **Priority published legacy (B4):** scheduler che pesca prima i 120; deep sui 12 HOT.
5. **Anti falso HOT (B3):** gate “fonte polizza senza policyFound ⇒ non HOT”; probe tutti HOT.
6. **Collapse REVIEW (B5)** agli irraggiungibili.
7. **Infra (B6):** OOM mitigation + anti-hog.
8. **Gate finale PASS solo se:** `retry==0`, `inProgress==0`, `terminal==877` (o pool size), REVIEW ⊆ unreachable proof, legacy PUB regressioni = 0 false HOT.

---

## 7. Vincoli operativi

- PowerShell locale **rompe** heredoc SSH: usare script scp + bash/python sul server.
- Non `APPLY_LIVE=1` senza ok utente.
- Protocollo chirurgico: una causa → una patch; niente refactor.
- Non inventare baseline 117 se il file manca: dichiararlo.
- UI Vercel ≠ motore Hetzner: published “pochi” = shadow run, non necessariamente live.

---

## 8. Verdetto onesto

Il motore **gira** e ha pezzi utili (HTML polizza, chromium, anti-fresh identity), ma **non** è un sistema che scansiona “perfettamente” i lead.  
La distanza dall’obiettivo è ancora **strutturale**: coda retry, identity falsa, published legacy non rivalidati, REVIEW larghi, OOM, e rischio residuo di falsi HOT.

**Cursor/Composer: non ha completato il mandato. Questo documento è il punto di partenza per Codex.**
