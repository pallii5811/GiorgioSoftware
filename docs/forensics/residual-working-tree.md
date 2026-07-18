# Residual working tree (post Fase 2 commits)

**HEAD:** `ffcf462fb4d37e3d4ba7db9ec40bbf0d4332cd26`  
**Tracked modifications:** none  
**Untracked (intentionally not committed):**

| Pattern | Decision |
|---------|----------|
| `scripts/audit-*.mjs`, `check-*.mjs`, `probe-*.mjs`, `fix-*.mjs`, delivery shells, etc. | Conservare localmente; tooling ops one-off; non necessari per shadow gate |
| `tmp-*.json` | Non commit — artefatti temporanei |
| `leadsniper-deploy.tgz`, `next-build.tgz` | Non commit — binary deploy artifacts |

Working tree **non** considerato “pulito”. Gate `READY FOR SHADOW` richiede tree controllato: i residui sono inventariati e non perdono lavoro (non è stato eseguito reset/clean).
