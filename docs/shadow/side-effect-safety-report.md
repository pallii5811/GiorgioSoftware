# Side-effect safety report

| Canale | Valore | Prova |
|--------|--------|-------|
| DB live writes (quarantine) | **0** | Marker `LEGACY:RESCAN_REQUIRED` solo su shadow; live markers = 0 (`live-safety-check.json`) |
| Record live modificati da quarantine | **0** | Confronto logico backup↔live: 0 cambi evidence/website/region/score/verdict/`updatedAt` |
| Record live cancellati | **0** | Lead count backup = live = 1237; onlyInBackup/onlyInLive = 0 |
| `legacyVerificationStatus` / shadow hist sul live | **0** | `liveShadowHistMarkers = 0` |
| Evidence version markers sul live | **0** | `liveEvidenceVersionMarkers = 0` |
| Coda pubblica | **0** | `DISABLE_PUBLIC_QUEUE_PUBLISH=true`; nessun publish |
| Timestamp attribuibili a quarantine sul live | **0** | max `updatedAt` / `lastScannedAt` identici backup↔live |
| Email | **0** | `DISABLE_EMAILS=true` |
| Webhook | **0** | `DISABLE_WEBHOOKS=true` |
| Notifiche cliente | **0** | `DISABLE_CUSTOMER_NOTIFICATIONS=true` |
| Cron produzione | **0** | `DISABLE_PRODUCTION_CRON=true`; nessun restart pm2 |
| Deploy | **0** | Nessun deploy Hetzner/Vercel in questa run |
| Push main | **0** | Branch shadow locale only |

## Distinzione operazioni

### Query di lettura (live)

- File SHA live vs backup
- Conteggio Lead / HOT
- Marker quarantine / hist / EV_V
- max `createdAt` / `updatedAt` / `lastScannedAt`
- Diff logico campi lead (fingerprint aggregati, no PII in report)

### Operazioni sullo shadow

- Restore pulito → `giorgio-shadow-20260718-rerun.db`
- Legacy audit + quarantine dry-run
- Apply quarantine (877 update) + seconda apply (0)
- Idempotenza verificata

### Assenza di write sul live

- Backup immutabile SHA invariato
- Live markers quarantine = 0 dopo apply shadow
- Nessuno script shadow apre live in write mode
- Drift classificato `METADATA_ONLY` (hash file diverso, zero drift logico)

## Live hash drift

Il file live può cambiare hash mentre produzione gira. Non è prova di scrittura shadow:

- backup file SHA invariato;
- zero cambi logici lead;
- quarantine markers sul live = 0.

Vedi anche: `docs/shadow/production-drift-summary.md`, `docs/shadow/ssh-hang-report.md`.
