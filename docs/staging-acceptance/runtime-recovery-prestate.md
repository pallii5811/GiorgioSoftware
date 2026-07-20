# Staging runtime recovery — prestate inventory

Inventario eseguito su HEAD `7afcd7daba221f2cb51729f858934783fe047b25` prima del recovery runtime.
Comandi: `git status --short`, `git diff`, `git ls-files --others --exclude-standard`.
**Vietato** `git reset --hard` / `git clean -fd` / `git checkout -- .`.

## Tracked modifications

| File | Scopo | Dati reali | Segreti | Decisione | Test |
|------|-------|------------|---------|-----------|------|
| `.gitignore` | Esclude `data/staging/`, frontier shadow | no | no | **KEEP** | n/a |

## Untracked — codice / harness (commit)

| File | Scopo | Dati reali | Segreti | Decisione | Test |
|------|-------|------------|---------|-----------|------|
| `src/lib/staging/guard.ts` | Fail-closed STAGING_MODE | no | no | **KEEP** | staging guard via harness |
| `scripts/staging-freeze-sample.mjs` | Freeze 12 ID campione | ID pubblici | no | **KEEP** | sample freeze in harness |
| `scripts/staging-acceptance-run.mjs` | Harness acceptance (da correggere: kill 45s) | riferimenti lead | no | **KEEP** (refactor) | staging-runtime |
| `scripts/staging-crawl-one.mjs` | Child crawl monolitico | no | no | **KEEP** (deprecato dal slice runner; resta util) | crawl-slices |

## Untracked — docs sanitizzati (commit)

| File | Scopo | Dati reali | Segreti | Decisione |
|------|-------|------------|---------|-----------|
| `docs/staging-acceptance/VERDICT.md` | Verdetto FAILED precedente | no | no | **KEEP** |
| `docs/staging-acceptance/environment-proof.json` | Proof env (URL redacted) | no | no | **KEEP** |
| `docs/staging-acceptance/migration-proof.json` | Conteggi schema | conteggi aggregati | no | **KEEP** |
| `docs/staging-acceptance/rollback-proof.json` | Rollback staging | conteggi | no | **KEEP** |
| `docs/staging-acceptance/sample-sanita.json` | 12 ID frozen | nomi strutture pubblici | no | **KEEP** |
| `docs/staging-acceptance/regression-diff.md` | Diff vs live SHA | no | no | **KEEP** |
| `docs/staging-acceptance/summary.json` | Summary gate | aggregati | no | **KEEP** (aggiornato da recovery) |
| `docs/staging-acceptance/api-ui-parity.json` | Shape API | CIG/nomi gare | no | **KEEP** |
| `docs/staging-acceptance/gare-campania.json` | 10 gare | dati pubblici ANAC | no | **KEEP** |
| `docs/staging-acceptance/gare-veneto.json` | 10 gare | dati pubblici | no | **KEEP** |
| `docs/staging-acceptance/hot-mutation-proof.json` | Mutation HOT reject | no | no | **KEEP** |
| `docs/staging-acceptance/robustness-proof.json` | Lock/resume | no | no | **KEEP** |
| `docs/staging-acceptance/sanita-rows.json` | Esiti 12 lead | nomi/URL | no | **KEEP** (sanitizzato) |
| `docs/staging-acceptance/test-matrix.txt` | Exit code suite | no | no | **KEEP** |
| `docs/staging-acceptance/fixtures/playwright-fixture-proof.json` | Proof PW | no | no | **KEEP** |
| `docs/staging-acceptance/fixtures/ocr-fixture-proof.json` | Proof OCR | testo sintetico | no | **KEEP** |

## Untracked — IGNORE / non commit (dati, log, binari)

| File / path | Motivo | Decisione |
|-------------|--------|-----------|
| `data/staging/**` | DB/frontier SQLite reali | **IGNORE** (già in `.gitignore`) |
| `docs/staging-acceptance/*.log` | Log grezzi | **IGNORE** (`*.log`) |
| `docs/staging-acceptance/build.out` | Build log | **DROP** / ignore |
| `docs/staging-acceptance/last-test.out` | Test log | **DROP** / ignore |
| `docs/staging-acceptance/crawl-*.err/out` | Probe stderr | **DROP** / ignore |
| `docs/staging-acceptance/crawl-probe*.json` | Probe temporanei | **DROP** / ignore |
| `docs/staging-acceptance/fixtures/ocr-scanned-fixture.pdf` | Binario fixture | **IGNORE** binari PDF in docs (rigenerabile) |
| `docs/staging-acceptance/crawl-tmp-*.json` | Temp crawl child | **IGNORE** |

## Nota operativa

Il campione `sample-sanita.json` è **immutabile** per la run `staging-runtime-recovery-20260719`.
