# Final production-grade status — 2026-07-19

## A. Verdetto

**NOT READY**

Motivi bloccanti quantificati (non opinioni):

1. **CrawlFrontierLedger** è derivato e stampato in evidence, **non** persistito come tabella/job checkpoint per ripresa retry (requisito §10).
2. **Waterfall 20 step**: ordine testabile in `resolution-waterfall.ts`; Playwright/OCR/registry non tutti collegati end-to-end sul path produzione (requisito §12).
3. **Benchmark funzionale shadow** 20 PUB + 20 HOT + 20 tech + 25/25 gare su DB snapshot: **non rieseguito** su HEAD post-gateway (solo corpus sintetico `benchmark-acceptance`, gatePass=true).
4. **Gare enrichment automatico** ANAC dettaglio (fetch lotto/award/documenti): status `ENRICHMENT_PENDING` esiste; loop fetch completo **non** operativo (requisito §16).
5. Path `analyzeRegional` usa identità `OFFICIAL_CONFIRMED` semplificata per il gate PUB — residuo di rischio attribuzione (§7).

Gate suite locali: PASS. Deploy/live write: zero.

---

## B. Repository

| Campo | Valore |
|-------|--------|
| Live application commit (manifest) | `ad38748ea59edd936b9c7def3a62fdd5ae9b4e2f` |
| Branch | `cto/final-production-grade-20260719` |
| HEAD iniziale sessione | `67212d2729fddadc28fd30f0898409415b2bc4ba` |
| HEAD finale | *(post-commit gateway+frontier)* |
| Base quality | `b311e99feeaf351b39c319e8f596374390a9ab56` |
| Snapshot SHA-256 | `cfb9e8781b2fb03c8989e3b79843cfbebb0742119c91e847e227a459909063ab` |
| Working tree | pulito dopo commit |
| Deploy | **non eseguito** |
| DB live | **non modificato** |

---

## C. PUBLISHED

- Fixture positive versionate: `tests/fixtures/sanita/published-characterization/` (current/expired/date-unknown/analogous).
- Characterization: **pass 29 / fail 0**.
- Defense (blog/directory/article/wrong-host): **pass 15 / fail 0**.
- `businessVerdict` vs `validationStatus`: implementati (`processing-state.ts`); tech fail preserva BV PUB.
- Sottostati via `canEmitPublished` + `published-subtype`.
- Persistenza CURRENT_VERIFIED: `prepareSanitaVerdictPersist` + `buildPublishedEmitEvidence` + `canEmitPublished`.
- Bypass audit statico: **pass 10 / fail 0** (scan-engine gated; policy-verify propone candidati, non scrive DB).
- Bug corretto: polizza scaduta non più forzata a HOT assenza in scan-engine recovery.

---

## D. HOT

- Gate unico: `canEmitHot` (+ frontier opzionale).
- `CrawlFrontierLedger` build+stamp; HOT bloccato se pending/failed/PDF/OCR aperti.
- Atomic: `assertAtomicHotPersist` / `HotIncompleteStopError`.
- hot-proof: **pass 30 / fail 0** (include frontier + RETRY_PENDING hint).
- Falsi HOT incompleti emessi nei test: **0**.

---

## E. Stati tecnici

- timeout/403/WAF → `RETRY_PENDING` (UI commerciale nascosta).
- retry esauriti su PUB storico → `TECHNICAL_BLOCKED` + BV preservato.
- ambiguità → `REVIEW_HUMAN`.
- `finalizeVerdict` incompletezza tecnica → hint `RETRY_PENDING` (non REVIEW_HUMAN al primo colpo).
- Benchmark sintetico: reviewHumanRateOnSanitaTech = **0**; retryPending=25; technicalBlocked=5.

---

## F–G. Gare

- `GARE_undefined` impossibile → `NON_CLASSIFICATO`.
- Missing date → `ENRICHMENT_PENDING` / poi `NOT_ACTIONABLE`.
- HIGH senza data/winner/source: bloccato da actionable-gate (suite PASS).
- Campania 25 / Veneto 25 shadow su questa HEAD: **non rieseguiti** (bloccante per READY).

---

## H. UX

- Badge HOT/REVIEW allineati a copy missione.
- Expired non “in regola” (ux-consistency PASS).
- RETRY/TECHNICAL nascosti da coda commerciale (`actionable-queue` / `HIDDEN_FROM_COMMERCIAL_UI`).
- Card campi completi (massimale/confidence/azione) — residuo parziale UI.

---

## I. Test (sessione)

| Comando | Exit | Note |
|---------|------|------|
| `npm test` | 0 | ~28s |
| `test:published-characterization` | 0 | 29 pass |
| `test:published-defense` | 0 | 15 pass |
| `test:hot-proof` | 0 | 30 pass |
| `test:state-machine` | 0 | 18 pass |
| `test:atomic-verdict` | 0 | 5 pass |
| `test:bypass-audit` | 0 | 10 pass |
| `test:gare-actionable` | 0 | 23 pass |
| `test:ux-consistency` | 0 | 13 pass |
| `typecheck` | 0 | |
| `lint` | 0 | 0 errors, 22 warnings |
| `benchmark-acceptance` | 0 | gatePass true |
| Clean worktree `npm ci` (HEAD precedente) | 0 | all suites; da ripetere su HEAD finale |

---

## J. Sicurezza

| Azione | Count |
|--------|-------|
| write live DB | 0 |
| deploy | 0 |
| email | 0 |
| webhook | 0 |
| cron live | 0 |
| cancellazioni | 0 |

---

## K. Rischi residui

1. Frontier non persistente → retry HOT senza checkpoint grafo (**alto** per HOT_VERIFIED in staging).
2. Shadow sample non rieseguito su gateway → tasso REVIEW_HUMAN reale sconosciuto su 60+ record (**medio-alto**).
3. Identità semplificata in `analyzeRegional` (**medio**).
4. Enrichment gare incompleto → coda actionable Campania/Veneto incompleta (**medio**).
