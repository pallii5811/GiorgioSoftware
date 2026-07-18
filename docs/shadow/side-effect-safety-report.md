# Side-effect safety report

| Canale | Valore | Prova |
|--------|--------|-------|
| DB live writes (quarantine) | **0** | Marker `LEGACY:RESCAN_REQUIRED` applicati solo su `giorgio-shadow-20260718.db`; backup live immutabile SHA `cfb9e878…` |
| Email | **0** | `DISABLE_EMAILS=true`; nessun provider email invocato dagli script shadow |
| Webhook | **0** | `DISABLE_WEBHOOKS=true` |
| Notifiche cliente | **0** | `DISABLE_CUSTOMER_NOTIFICATIONS=true` |
| Coda pubblica publish | **0** | `DISABLE_PUBLIC_QUEUE_PUBLISH=true`; nessun deploy UI |
| Cron produzione | **0** | `DISABLE_PRODUCTION_CRON=true`; nessuno start pm2 |
| Deploy | **0** | Nessun `hetzner-deploy` / Vercel deploy eseguito |
| Push main | **0** | Branch shadow locale only |

## Live hash drift

Il file live può cambiare hash mentre produzione gira. Non è prova di scrittura shadow:  
- backup file SHA invariato;  
- quarantine markers sul live = 0 (verifica script isolation).
