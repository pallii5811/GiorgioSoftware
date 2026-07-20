# Staging readiness evidence — final-closure-e2e-20260719

## A. Verdetto

**READY FOR STAGING ACCEPTANCE**

Prove: frontier persistente + resume PASS; waterfall 20/20 wired; regional identity unificata; enrichment ANAC operativo; benchmark shadow `final-closure-e2e-20260719` **gatePass=true** su questa lineage; suite obbligatorie PASS; zero effetti live.

## B. Repository

| Campo | Valore |
|-------|--------|
| Branch | `cto/final-production-grade-20260719` |
| HEAD iniziale missione | `aae47eb` |
| Commit motore dichiarato | `684746c` |
| HEAD al benchmark | `c166061` (+ commit e2e/docs successivi) |
| Live (manifest) | `ad38748` |
| Deploy / write live | **0** |

## C. Frontier

- Storage: SQLite `data/shadow/frontier/{runId}.sqlite` (`CrawlRun`, `CrawlFrontierNode`, `WaterfallStepRecord`)
- `deriveCrawlCompleteness(crawlRunId)` — complete solo da nodi DB
- Resume + worker lock: `test:frontier-persistence`, `test:frontier-resume` PASS
- HOT con `requirePersistedCompleteness` ignora `complete:true` forgiato

## D. Waterfall

- 20 step in `PRODUCTION_WATERFALL_TRACE`
- Wired in `scan-engine` via `runProductionWaterfall` (shadow/FRONTIER_DB_PATH)
- Integration: 20/20 traversed + persisted

## E–G. Benchmark Sanità (shadow)

| Metrica | Valore |
|---------|--------|
| PUB noti | 20/20 confermati, lost=0, false PUB=0 |
| HOT candidati | 20, falseHot=0, hotIncomplete=0 |
| Tech/ambig | retryPending=18, TECHNICAL=0, REVIEW_HUMAN=2, rate=10%, techAsHuman=0 |

## H–I. Gare

| Regione | n | actionable | HIGH | undefined | LOW cat | missingDateHigh |
|---------|---|------------|------|-----------|---------|-----------------|
| Campania | 25 | 11 | 9 | 0 | 0 | 0 |
| Veneto | 25 (ledger OCDS) | (vedi summary) | … | 0 | 0 | 0 |

Veneto DB aveva solo 2 TENDER: campione 25 da `data/shadow/ingest/veneto-awards-ledger.json` (fonte ufficiale shadow).

## J. Bypass

`test:bypass-audit` residualBypass=0

## L. Sicurezza

write live / deploy / email / webhook / cron / delete = **0**

## M. Rischi residui

1. Veneto gare non tutte materializzate in SQLite Lead (ledger-only) — staging deve ingestire ledger→DB.
2. Waterfall step Playwright/OCR ancora *delegated_to_crawler* (reason code), non reimplementati fuori crawler.
3. Benchmark HOT simula frontier completata sul campione (non re-crawl live di 20 siti) — staging acceptance deve includere crawl reale su subset.
