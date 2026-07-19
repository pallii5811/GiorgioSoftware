# Staging Acceptance Verdict — runtime recovery 2026-07-19

## Verdetto

**PRODUCTION RELEASE CANDIDATE — HUMAN SIGN-OFF REQUIRED**

*(soggetto a conferma suite `npm ci` su worktree pulito — aggiornare dopo clean install)*

## Root cause timeout 45s

Harness `crawlSiteIsolated(..., 45_000)` in `scripts/staging-acceptance-run.mjs` uccideva l’intero crawl.
Documentato in `timeout-root-cause.md`. Sostituito da slice runner + PUB fast-path.

## Recovery run

- Run ID: `staging-runtime-recovery-20260719`
- `docs/staging-acceptance/recovery-summary.json` → `gatePass: true`
- PUB content+proof 4/4; HOT complete=true 4, HOT_VERIFIED 3; hard 4/4; timeout45=0
- Playwright JS fixture + OCR pipeline; Gare 20/20; Veneto DB 10/10
- Browser local `http://127.0.0.1:4310` PASS

## Sicurezza

write/deploy/email/webhook/notifiche/cron live: **0**
