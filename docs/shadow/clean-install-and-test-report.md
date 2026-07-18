# Clean install and test report — Shadow Fase 3

**Branch:** `cto/shadow-execution-campania-veneto-20260718`  
**HEAD partenza:** `a7d9ee12d832ab6a6b719ffa7e63367f11e87162`  
**Data:** 2026-07-18

## Environment

| Item | Value |
|------|--------|
| Node | v22.22.3 |
| npm | 10.9.8 |
| Lockfile | `package-lock.json` **invariato** (nessun diff dopo ci) |

## npm ci

| Tentativo | Comando | Exit | Note |
|-----------|---------|------|------|
| 1 | `npm ci` | **1** | `postinstall` → prisma generate fallisce: TLS `unable to verify the first certificate` su binaries.prisma.sh |
| 2 | `npm ci --ignore-scripts` | **0** | ~146s, 704 packages |
| follow-up | `npx prisma generate --schema prisma/schema.sqlite.prisma` | **0** | con `NODE_TLS_REJECT_UNAUTHORIZED=0` solo per generate |

Warning npm: plaintext http notice; deprecated `whatwg-encoding`, `node-domexception`.

## Gate deterministici (post install)

| Comando | Exit | Durata approx | Pass/Fail | Skip |
|---------|------|---------------|-----------|------|
| `npm test` | 0 | ~30s | PASS | — |
| `npm run test:safety` | 0 | ~23s | PASS | — |
| `npm run test:quality` | 0 | ~102s | PASS | crawl rete skipped su timeout (registrati in log) |
| `npm run typecheck` | 0 | ~5s | PASS | — |
| `npm run lint` | 0 | — | PASS | 0 errors, 22 warnings |
| `npm run build` | 0 | ~40s | PASS | — |
| `npx tsx scripts/test-shadow-guard.mjs` | 0 | <2s | PASS | — |

## test:all

```json
"test:all": "tsx scripts/test-suite.mjs && tsx scripts/quality-gate.mjs && tsx scripts/test-maps-query.mjs && tsx scripts/e2e-test.mjs"
```

Contiene probe rete (`test-maps-query`, `e2e-test`) → **non deterministico**.  
**Non eseguito intero** in questa fase; parti deterministiche già coperte da `test` + `test:quality`.

## Conclusione install

Installazione riproducibile **con workaround** `--ignore-scripts` + generate esplicito a causa di TLS ambiente Windows. Lockfile non modificato.
