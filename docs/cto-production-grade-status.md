# CTO Production-Grade Status — Campania / Veneto

**Branch:** `cto/campania-veneto-production-grade-20260718`  
**HEAD iniziale:** `1c25287128a490b93bf84268d230083405ea2663`  
**Data:** 2026-07-18  
**Patch `giorgio-zero-false-hot.patch`:** **ASSENTE** nel repo (non applicata).

## Verdetto attuale

**`NOT READY`**

Motivi bloccanti (gate missione §31–32):

1. Coverage ledger fonti ufficiali Ministero/ASL/ULSS **non ancora popolato** con 0 unresolved.
2. Gold dataset 100+100 Sanità / 100+100 Gare **non creato**.
3. Verifica umana 100% HOT / VERY_HIGH **non eseguita**.
4. Shadow/canary/deploy **non avviati** (vietato dalla missione fino ai gate).
5. DB Hetzner live ancora con ~242 REVIEW (numeri precedenti): non riconciliato con nuovi gate.

## Cosa è stato implementato in questo branch (fondamenta)

| Modulo | Path | Scopo |
|--------|------|--------|
| Evidence contract | `src/lib/evidence/contract.ts` | LeadEvidence, CrawlCompleteness (complete **derivato**), SourceCoverage, CommercialOpportunity |
| Registry Sanità | `src/lib/sanita/source-registry.ts` | Fonti ufficiali vs discovery |
| Registry Gare | `src/lib/gare/source-registry.ts` | ANAC primario + recency buckets |
| Commercial Sanità | `src/lib/sanita/commercial.ts` | Score deterministico; HOT incompleto → NOT_ACTIONABLE |
| Commercial Gare | `src/lib/gare/commercial.ts` | Score 0–100; **cauzione = ESTIMATE** |
| Crawl | `src/lib/sanita/crawler.ts` | Sitemap XML, completeness, urlCapReached ≠ complete |
| Verdict gate | `src/lib/sanita/verdict.ts` | HOT bloccato se crawl incompleto / unreachable / OCR |
| Scan wiring | `src/lib/sanita/scan-engine.ts` | Passa crawlCompleteness a finalizeVerdict |
| UI Gare | `src/components/gare-leads.tsx` | Label “Stima (non documentata)” |

## Regole enforceate

- Timeout / 403 / cap URL / OCR dubbio / coda HTML non vuota → **REVIEW**, mai HOT assenza.
- Cauzione 10% → **ESTIMATE**, non fatto.
- OpenAI: dipendenza in `package.json` ma **nessun import runtime** in `src/` (solo Tavily usato).

## Prossimi passi obbligatori (ordine)

1. Ingest Ministero + elenchi ASL/ULSS → SourceCoverage ledger JSON/CSV.
2. Wire `CommercialOpportunity` in evidence pack + UI Sanità (motivo preciso).
3. Riscan Hetzner con nuovi gate (un job alla volta) + backup DB.
4. Gold dataset + human review HOT.
5. Solo allora: shadow → canary → delivery.

## Comandi verifica

```bash
npm test
npm run test:quality
npm run build
```

Non dichiarare READY FOR PRODUCTION finché i gate §24–32 non sono verdi con prove.
