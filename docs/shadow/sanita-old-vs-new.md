# Sanità old vs new — Shadow Fase 3

## Scope eseguito

1. Snapshot immutabile pre-quarantine (`data/shadow/before/*.jsonl` — non committato, sensibile)  
2. Quarantine apply su shadow: 877 healthcare → `LEGACY:RESCAN_REQUIRED` + `[SHADOW_HIST_VERDICT:…]`  
3. Second apply: **0** update → idempotente  
4. Lead total invariato: **1237**

## Transition matrix (verdetto storico → stato operativo shadow)

| Transizione | Conteggio approx | Note |
|-------------|------------------|------|
| HOT → RESCAN_REQUIRED (legacy) | 515 | Token `[V:HOT]` conservato + hist marker |
| PUBLISHED → RESCAN_REQUIRED | 120 | Idem |
| REVIEW → RESCAN_REQUIRED | 242 | Marcati con gli altri healthcare |
| HOT → HOT (ri-certificato v2) | **0** | Nessun riscan crawl ancora |
| PUBLISHED → PUBLISHED (v2) | **0** | Idem |

## Batch

| Batch | Stato |
|-------|--------|
| S0 preflight deterministico | **PASS** via `npm test` + quality (fixture expired/auto/identity) |
| S1 25+25 crawl | **NON ESEGUITO** (rete/tempo; stop: evitare crawl massivo senza worker dedicato) |
| S2 100+100 | **NON ESEGUITO** (dipende S1) |
| S3 coda legacy completa crawl | **NON ESEGUITO** — coda riscan popolata logicamente (RESCAN_REQUIRED) ma crawl non lanciato |

## Stop conditions

Nessuna stop condition di sicurezza (live write / email / falso HOT automatizzato in test) attivata.  
Stop **operativo**: batch crawl S1+ non avviati → shadow incompleto su elaborazione siti.
