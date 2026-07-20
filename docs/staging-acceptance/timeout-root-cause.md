# Timeout root cause — `timeout_crawlSite_45000ms`

## Sintesi

Tutti i 12 record della staging acceptance precedente sono falliti con lo **stesso** messaggio perché l’**harness** uccideva il processo figlio del crawl dopo esattamente **45 000 ms**. Non era un timeout interno di `crawlSite`, né di Playwright, né del database.

## Catena osservata

```
staging-acceptance-run.mjs
  → crawlSiteIsolated(url, 45_000)
       → spawn(scripts/staging-crawl-one.mjs)
       → setTimeout(45_000) → taskkill / SIGKILL
       → resolve({ ok:false, error: `timeout_crawlSite_45000ms` })
  → resolveAfterTechnicalFailure → RETRY_PENDING + PUB token preservato
```

## Punti codice

| File | Funzione | Deadline | Cosa abortisce | Cosa salva | Cosa perde |
|------|----------|----------|----------------|------------|------------|
| `scripts/staging-acceptance-run.mjs` | `crawlSiteIsolated` default `ms=45_000` | 45s wall | **intero** child process crawl | quasi nulla (file out spesso assente) | pages, PDF, OCR, frontier nodi del child |
| `scripts/staging-acceptance-run.mjs` | loop `crawlSiteIsolated(item.website, 45_000)` | 45s/lead | come sopra | riga RETRY_PENDING | contenuto acquisito |
| `scripts/staging-crawl-one.mjs` | `crawlSite(url)` | nessuno proprio | — | JSON out se completa | — |
| `src/lib/sanita/crawler.ts` | `crawlSite` / `crawlSiteInner` | timeout **per fetch** (12–25s) via `externalFetch` | singola URL | n/a nel harness (processo ucciso) | — |
| `src/lib/http.ts` | `externalFetch` | `timeoutMs` (default 20s) | singola request AbortController | — | — |
| `src/lib/sanita/policy-playwright.ts` | `page.goto` | 45s **navigation** | pagina browser | — | non raggiunto: child già killato |
| `scripts/quality-gate.mjs` | `withTimeout(..., 45_000)` | 45s race | Promise crawl (altro contesto QA) | — | non è la causa della run staging |

## Perché 12/12 allo stesso istante

1. Ogni lead usava **lo stesso** parametro `45_000`.
2. `crawlSite` su siti reali (probe path lunghi + PDF) tipicamente **supera** 45s wall clock.
3. Il kill del child è **deterministico** a T+45s → stesso error string per tutti.
4. Non c’era resume: ogni lead ripartiva da zero nel child e veniva di nuovo ucciso.

## Cause escluse (prove)

| Ipotesi | Esito |
|---------|-------|
| Sito irraggiungibile | **No** — HTTP probe 200 su Minerva/Heidy/Progenia in <10s |
| Deadlock DB frontier | **No** — frontier si apriva; fallimento prima di persistenza utile |
| Playwright init blocca tutti | **No** — con `POLICY_EXHAUSTIVE=0` PW a fine crawl spesso non partiva; kill a 45s comunque |
| Timeout in `crawlSite` con messaggio `timeout_crawlSite_45000ms` | **No** — stringa costruita **solo** nell’harness |

## Root cause precisa

**Modello monolitico nell’harness staging:** `Promise`/`spawn` + kill a 45s sull’**intero** crawl del lead, senza slice, senza checkpoint, senza continuità frontier.

## Patch richiesta (questa recovery)

1. Eliminare `crawlSiteIsolated(..., 45_000)` come errore terminale del lead.
2. Introdurre runner a **slice** su frontier persistente (`CRAWL_SLICE_BUDGET_MS`, non kill globale a 45s).
3. Fast-path PUBLISHED su URL `[DOCS:]` storico.
4. Test di regressione: crawl >45s logici senza `timeout_crawlSite_45000ms`.
