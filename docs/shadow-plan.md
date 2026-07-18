# Shadow plan — Campania / Veneto

## Prerequisiti

1. Branch `cto/campania-veneto-production-grade-20260718` con test verdi.
2. Backup DB (Hetzner o copia locale):
   ```bash
   # Hetzner (NON eseguire in questa fase senza approvazione)
   cp /opt/leadsniper/prisma/dev.db /opt/leadsniper/backups/dev-$(date -Iseconds).db
   ```
3. Restore test:
   ```bash
   cp /path/to/backup.db /path/to/restore-test.db
   DATABASE_URL=file:/path/to/restore-test.db npx tsx scripts/pending-count.mjs
   ```

## Feature flags

```env
ACTIONABLE_QUEUE_REQUIRE_CURRENT_EVIDENCE=true
POLICY_EXHAUSTIVE=1
SCAN_FAST=0
SHADOW_MODE=1
```

## Shadow run (locale / copia DB)

1. Copia DB → non toccare live.
2. `ACTIONABLE_QUEUE_REQUIRE_CURRENT_EVIDENCE=true` → coda `?actionable=1` vuota o quasi (legacy esclusi).
3. Dry-run legacy: `npm run sanita:legacy-audit`
4. Confronto old/new: export JSON before/after su copia.
5. Metriche: count HOT/PUB/REVIEW, actionableCount, legacyHot.

## Canary (vietato finché coverage + human review)

- Un worker, batch piccolo Campania, stop su falso HOT/PUB.

## Stop conditions

- Falso HOT / falso PUBLISHED
- Vincitore gare errato
- Contaminazione identità
- unresolvedRecords > 0 su fonte marcata complete
- Lock SQLite persistente

## Rollback

```bash
# Ripristina binario + DB dal backup
pm2 stop leadsniper-ui
cp /opt/leadsniper/backups/<file>.db /opt/leadsniper/prisma/dev.db
# checkout commit precedente
pm2 start leadsniper-ui
```
