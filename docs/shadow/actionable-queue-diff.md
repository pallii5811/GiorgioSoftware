# Actionable queue diff — Shadow

## Definizioni

- **Coda commerciale “pre-gate” (esposizione legacy):** HOT+PUBLISHED con token verdetto, senza filtro evidence v2.  
- **Coda commerciale “post-gate”:** `isActionableEvidence` / pipeline shadow (`LEGACY:CURRENT` + verdetto HOT/PUB).

## Conteggi (copia shadow da live 2026-07-18)

| Metrica | Valore |
|---------|--------|
| Lead total (immutato) | 1237 |
| Sanità Campania HOT+PUB pre | 285+72 = **357** |
| Sanità Veneto HOT+PUB pre | 230+48 = **278** |
| Esposizione commerciale Sanità pre (HOT+PUB) | **635** |
| Actionable post-quarantine (Sanità+Gare) | **0** |
| Legacy HOT ancora con token storico | 515 (marcati RESCAN_REQUIRED, esclusi da coda) |
| Legacy PUB | 120 (idem) |
| Legacy actionable dopo | **0** |

## Motivi rimozione (tutti i 635)

| Motivo | Conteggio |
|--------|-----------|
| `missing evidenceVersion/verdictVersion` → legacy | 635 HOT/PUB |
| `legacyVerificationStatus=RESCAN_REQUIRED` dopo apply | 877 healthcare marcati |
| REVIEW già non actionable | 242 |

## Gate assoluti (post)

| Gate | Valore |
|------|--------|
| Legacy in nuova coda | **0** |
| Identità non verificata in coda | **0** (coda vuota) |
| HOT incompleti in coda | **0** |
| Technical failure terminali in coda | **0** |

## Nota

Prima dello snapshot shadow, `actionable` calcolato con i nuovi gate era già 0 (nessun record CURRENT).  
Il valore commerciale “pre” per il cliente in produzione equivaleva all’esposizione dei token HOT/PUB legacy (**635** Sanità), non al gate v2.
