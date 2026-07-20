# Pre-closure working tree inventory

**Branch:** `cto/quality-10-published-hot-gare-20260719`  
**HEAD:** `086110d34e8034482cfc47e320d8840c38ef4078`  
**Inventoried:** 2026-07-19  
**Rule:** no `reset --hard` / `clean -fd` / discard

## Modified tracked files

| File | Funzione | Origine | Rischio | Test | Sensibile | Decisione |
|------|----------|---------|---------|------|-----------|-----------|
| `.gitignore` | gitignore `data/baseline/*.jsonl` | missione 10/10 | basso | n/a | no | **commit** (baseline pack 1) |
| `package.json` | script test nuovi | missione 10/10 | basso | scripts stessi | no | **commit** (con test) |
| `scripts/test-suite.tsx` → `test-suite.mjs` | canEmitHot / scaduta→PUB | missione 10/10 | medio (assert HOT) | suite stessa | no | **commit** (HOT pack) |
| `src/components/sanita-leads.tsx` | badge sottotipi PUB | missione 10/10 | UX | test:ux-consistency | no | **commit** (UX) |
| `src/lib/sanita/audit.ts` | PUB_EXPIRED helper | missione 10/10 | basso | ux/hot | no | **commit** (UX) |
| `src/lib/sanita/commercial.ts` | testo senza "in regola" | missione 10/10 | basso | test suite | no | **commit** (UX) |
| `src/lib/sanita/policy-verify.ts` | scaduta→PUBLISHED | missione 10/10 | alto (verdict) | test-suite, defense | no | **commit** (HOT/PUB gate) |
| `src/lib/sanita/scan-engine.ts` | Tavily→REVIEW, canEmitHot persist | missione 10/10 | alto | hot-proof, defense | no | **commit** (HOT gate) |
| `src/lib/sanita/verdict.ts` | finalizeVerdict→canEmitHot | missione 10/10 | alto | hot-proof | no | **commit** (HOT gate) |

## Untracked

| Path | Funzione | Origine | Rischio | Test | Sensibile | Decisione |
|------|----------|---------|---------|------|-----------|-----------|
| `docs/baseline/published-live-v1-ids.json` | 120 ID opachi | freeze script | basso | published-baseline | no (solo ID) | **commit** |
| `docs/baseline/published-live-v1-report.md` | report aggregato | freeze | basso | published-baseline | no | **commit** |
| `data/baseline/published-live-v1.jsonl` | PII baseline | freeze | alto | published-baseline | **sì** | **gitignore** (già) |
| `docs/quality-10/mission-report-20260719.md` | report NOT READY | missione | basso | n/a | no | **commit** (report) |
| `scripts/freeze-published-baseline.py` | freeze tool | missione | basso | published-baseline | no | **commit** |
| `scripts/test-*.mjs` (5 suite) | gate quality | missione | basso | self | no | **commit** |
| `src/lib/gare/actionable-gate.ts` | gate coda gare | missione | medio | gare-actionable | no | **commit** (gare) — fix NON_CLASSIFICATO before commit |
| `src/lib/sanita/atomic-verdict.ts` | fail-closed HOT | missione | alto | hot-proof | no | **commit** (HOT) |
| `src/lib/sanita/can-emit-hot.ts` | gate HOT unico | missione | alto | hot-proof | no | **commit** (HOT) |
| `src/lib/sanita/discovery-gate.ts` | no PUB da discovery | missione | alto | published-defense | no | **commit** (HOT/PUB) |
| `src/lib/sanita/published-subtype.ts` | sottostati PUB | missione | medio | ux + baseline | no | **commit** (baseline/UX) |

## Commit plan (ordered)

1. **baseline** — gitignore, freeze script, docs/baseline IDs+report, published-subtype (needed by baseline tests), test-published-baseline  
2. **hot-atomic** — can-emit-hot, atomic-verdict, discovery-gate, verdict, policy-verify, scan-engine, audit, test-hot-proof, test-published-defense, test-suite bits  
3. **gare** — actionable-gate (corrected NON_CLASSIFICATO), display/contract fixes, test-gare-actionable  
4. **ux-tests** — sanita-leads, commercial, package.json scripts, test-ux-consistency  
5. **report** — docs/quality-10, docs/final-closure  

## Explicit non-actions

- No live DB write  
- No deploy  
- No `main` merge/push  
- No discard of local changes  
