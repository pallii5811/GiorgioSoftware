# Residual working tree (post Fase 2 + quality/lint closure)

**Local ops scripts / tmp / tgz:** ignored via `.gitignore` (files remain on disk, not discarded).

| Pattern | Decision |
|---------|----------|
| `scripts/audit-*`, `check-*`, `probe-*`, … | Conservati in locale; gitignored — tooling one-off |
| `tmp-*.json`, `*.tgz` | Non commit — artefatti |
| Product `src/`, coverage, human-review, forensics | Committed |

Working tree considerato **controllato** quando `git status` è pulito sui path di prodotto.
