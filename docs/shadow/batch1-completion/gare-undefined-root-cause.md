# Root cause — `GARE_undefined`

## Cause

`relevanceCategory(relevance)` in `src/lib/gare/display.ts` interpolated a missing relevance:

```ts
return `GARE_${relevance}`; // → "GARE_undefined" when relevance is undefined
```

Historical writes (enrich/engine paths with missing `meta.relevance`) stored the literal category `GARE_undefined` on 312/360 tender leads in the immutable snapshot.

## Fix

1. **Guard** in `relevanceCategory`: coerce invalid relevance → `LOW` (never emit undefined).
2. **`normalizeGareRelevanceCategory`**: recompute HIGH/MEDIUM/LOW from object/amount when category is missing/`GARE_undefined`.
3. **`classifyGareContractType`**: separate LAVORI/SERVIZI/FORNITURE/CONCESSIONI/MISTO/NON_CLASSIFICATO from broker relevance; stamp `[CONTRACT_TYPE:…]` on evidence.
4. **Shadow repair** (`scripts/shadow-fix-gare-undefined.mjs`): 312 fixed; `undefinedAfter: 0`; 108 `NON_CLASSIFICATO`.

## Tests

`scripts/test-gare-contract-type.mjs` — lavori/servizi/forniture/misto/missing/CPV/ambiguous + undefined normalization.
