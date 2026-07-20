# Working tree inventory — Fase 2 CTO

**Branch:** `cto/campania-veneto-production-grade-20260718`  
**HEAD at forensics:** `6000609c04bd65dbb383a2f823379aeea65a7c31`  
**Generated:** 2026-07-18  
**Patches saved:** `docs/forensics/preexisting-working-tree.patch` (~213KB), `preexisting-index.patch`

## Modified tracked files (pre-existing vs 6000609)

| Path | Area | Funzione della modifica | Necessario? | vs 6000609 | Decisione |
|------|------|-------------------------|-------------|------------|----------|
| `src/lib/sanita/detector.ts` | Sanità | Anti falsi PUB (budget/ULSS), date, massimali RCT | Sì | Non in 6000609 | **Integrare** |
| `src/lib/sanita/policy-verify.ts` | Sanità | Gate PUB/HOT, autoassicurazione | Sì | Non in 6000609 | **Integrare** (fix HTML auto) |
| `src/lib/sanita/site-identity.ts` | Sanità | Identità sito | Sì | Non in 6000609 | **Integrare** |
| `src/lib/sanita/audit.ts` | Sanità | Trail fonti | Sì | Non in 6000609 | **Integrare** |
| `src/lib/sanita/gelli-scope.ts` | Sanità | Scope Gelli | Sì | Non in 6000609 | **Integrare** |
| `src/lib/sanita/lead-dedup.ts` | Sanità | Dedup | Sì | Non in 6000609 | **Integrare** |
| `src/lib/sanita/resolve-website.ts` | Sanità | Risoluzione sito | Sì | Non in 6000609 | **Integrare** |
| `src/lib/sanita/guess-website.ts` | Sanità | Guess dominio | Sì | Non in 6000609 | **Integrare** |
| `src/lib/sanita/contacts.ts` | Sanità | Contatti | Utile | Non in 6000609 | **Integrare** |
| `src/lib/sanita/maps-query.ts` | Sanità | Maps | Utile | Non in 6000609 | **Integrare** |
| `src/lib/sanita/ocr.ts` | Sanità | OCR | Utile | Non in 6000609 | **Integrare** |
| `src/lib/sanita/website.ts` | Sanità | Host blocked | Utile | Non in 6000609 | **Integrare** |
| `src/lib/sanita/website-enrichment.ts` | Sanità | Enrich | Minore | Non in 6000609 | **Integrare** |
| `src/components/sanita-leads.tsx` | UI | Motivi REVIEW / layout | Sì | Non in 6000609 | **Integrare** |
| `src/components/lead-detail.tsx` | UI | Detail | Minore | Non in 6000609 | **Integrare** |
| `scripts/rescan-*.mjs`, `strict-reaudit-*`, `review-breakdown`, `hetzner-deploy`, `download-tessdata`, `test-gare-scan`, `fix-delivery-blockers` | Infra/ops | Pipeline Hetzner / rescan | Ops | Non in 6000609 | **Integrare** ops scripts |

## Untracked (sample policy)

| Pattern | Decisione |
|---------|----------|
| `scripts/audit-*.mjs`, `check-*.mjs`, `probe-*.mjs`, `fix-*.mjs`, delivery shells | **Conservare** come tooling ops; commit selettivo senza tmp |
| `src/lib/sanita/tavily-crawl-fallback.ts` | **Integrare** (usato da scan-engine) |
| `tmp-*.json`, `leadsniper-deploy.tgz`, `next-build.tgz` | **Non toccare / non commit** |

## Rischio perdita

Tutte le modifiche sono in `preexisting-working-tree.patch`. Nessun `reset --hard` eseguito.
