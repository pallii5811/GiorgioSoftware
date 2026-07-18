# Coverage Sanità — Campania

## Stato

**Ledger eseguibile:** sì (pipeline stub + registry).  
**Copertura completa dichiarabile:** **NO** — fonti ufficiali non ancora ingestite al 100%.

## Fonti configurate

Vedi `src/lib/sanita/source-registry.ts`:

- Ministero della Salute (primaria)
- Regione Campania
- ASL Campania (da espandere per provincia)
- Maps/Tavily = discovery only

## Come generare

```bash
npm run sanita:legacy-audit
# Ingest fonti (da implementare worker): npm run coverage:sanita -- Campania
```

Output atteso:

- `data/coverage/sanita/campania/source-*.json`
- questo report aggiornato con: rawRecords, parsed, unique, duplicates, exclusions, unresolved, failures

## Regola

`completed: true` soltanto con `unresolvedRecords === 0` e pagine/allegati processati.
