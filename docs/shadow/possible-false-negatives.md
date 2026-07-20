# Possible false negatives — Shadow

Dopo quarantine, la coda commerciale shadow è vuota.

| Rischio FN | Quantificazione | Mitigazione |
|------------|-----------------|-------------|
| HOT reali nascosti fino a riscan | fino a **515** | Coda `RESCAN_REQUIRED`; pack human-review priority |
| PUBLISHED reali nascosti | fino a **120** | Idem |
| Gare HIGH nascoste | fino a actionable gare legacy | Serve marker CURRENT post-verifica |

Questi non sono “lead cancellati”: record e verdetto storico conservati.
