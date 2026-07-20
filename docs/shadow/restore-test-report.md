# Restore test report — Shadow local copy

| Campo | Valore |
|--------|--------|
| Copia locale backup | `data/shadow/db/giorgio-live-backup-20260718.db` |
| DB shadow operativo | `data/shadow/db/giorgio-shadow-20260718.db` |
| SHA-256 | `cfb9e8781b2fb03c8989e3b79843cfbebb0742119c91e847e227a459909063ab` |
| Match backup Hetzner | **true** |
| Integrity shadow | `ok` |
| Lead total | 1237 |
| HOT | 515 |
| PUBLISHED | 120 |
| REVIEW | 242 |

## Isolamento

- `DATABASE_URL` locale `.env` = `file:./dev.db` (non Hetzner)
- Shadow pipeline usa solo `SHADOW_DB_PATH` → `giorgio-shadow-20260718.db`
- Guard rifiuta `file:/opt/leadsniper/prisma/dev.db` con `SHADOW_MODE=true`

## Live hash drift (atteso)

Dopo il backup, il file live su Hetzner può cambiare hash perché **pm2 produzione continua a scrivere**.  
Il file di **backup** resta immutabile e uguale al meta SHA.  
Verifica isolamento: marker `LEGACY:RESCAN_REQUIRED` sul live devono essere **0** (quarantine solo su shadow).

Restore test: **PASS**
