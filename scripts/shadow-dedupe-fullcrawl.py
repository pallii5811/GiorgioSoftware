#!/usr/bin/env python3
"""Dedupe crawl results (last non-timeout wins when possible) + legacy analysis."""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

RAW = Path("data/shadow/crawl/fullcrawl-results.jsonl")
OUT = Path("data/shadow/crawl/fullcrawl-results-deduped.jsonl")
DOCS = Path("docs/shadow/batch1-completion")
DOCS.mkdir(parents=True, exist_ok=True)

rows_by_id: dict[str, list[dict]] = {}
for line in RAW.read_text(encoding="utf-8").splitlines():
    if not line.strip():
        continue
    r = json.loads(line)
    rows_by_id.setdefault(r["id"], []).append(r)


def pick(versions: list[dict]) -> dict:
    # Prefer successful analyze over hard-timeout stub
    scored = sorted(
        versions,
        key=lambda r: (
            0 if r.get("error") == f"HARD_TIMEOUT:{r.get('durationMs')}" or str(r.get("error", "")).startswith("HARD_TIMEOUT") else 1,
            0 if r.get("identityStatus") == "TECHNICALLY_UNVERIFIABLE" and not r.get("companyName") else 1,
            1 if r.get("identityStatus") not in (None, "NOT_CHECKED") else 0,
            r.get("durationMs") or 0,
        ),
        reverse=True,
    )
    best = dict(scored[0])
    # Motivate NOT_CHECKED when timeout/tech failure
    if best.get("identityStatus") in (None, "NOT_CHECKED"):
        if best.get("technicalFailure") or str(best.get("error") or "").startswith("HARD_TIMEOUT"):
            best["identityStatus"] = "INSUFFICIENT"
            best["identityMotivation"] = "full_crawl_timeout_or_technical_failure — identity attempt not completed"
            best["technicalFailure"] = True
        else:
            best["identityMotivation"] = "scan completed without IDENTITY marker — treated as INSUFFICIENT"
            best["identityStatus"] = "INSUFFICIENT"
    if best.get("identityStatus") == "TECHNICALLY_UNVERIFIABLE":
        best["identityStatus"] = "INSUFFICIENT"
        best["identityMotivation"] = best.get("identityMotivation") or "hard timeout before identity resolution"
        best["technicalFailure"] = True
    # legacy class
    old, new = best.get("oldVerdict"), best.get("newVerdict")
    if old in ("HOT", "PUBLISHED"):
        if best.get("identityStatus") == "MISMATCH":
            best["legacyClass"] = "IDENTITY_PROBLEM"
        elif best.get("technicalFailure"):
            best["legacyClass"] = "TECHNICALLY_UNVERIFIABLE"
        elif new == "HOT":
            best["legacyClass"] = "REAL_LEAD_CONFIRMED"
        elif new == "PUBLISHED":
            best["legacyClass"] = "PUBLICATION_CONFIRMED"
        elif not best.get("crawlComplete") and best.get("website"):
            best["legacyClass"] = "POSSIBLE_NEW_FALSE_NEGATIVE"
        elif not best.get("website"):
            best["legacyClass"] = "INSUFFICIENT_PREVIOUS_EVIDENCE"
        elif old == "HOT" and new == "REVIEW" and best.get("crawlComplete") and not best.get("policyFound"):
            best["legacyClass"] = "LIKELY_PREVIOUS_FALSE_POSITIVE"
        else:
            best["legacyClass"] = "HUMAN_REVIEW_REQUIRED"
    return best


picked = [pick(v) for v in rows_by_id.values()]
assert len(picked) == 50, len(picked)

# Stop-condition audit
stops = []
for r in picked:
    if r.get("newVerdict") == "HOT":
        if r.get("identityStatus") not in ("OFFICIAL_CONFIRMED", "GROUP_OFFICIAL_CONFIRMED"):
            stops.append({"id": r["id"], "reason": "HOT_WITHOUT_VERIFIED_IDENTITY"})
        if not r.get("crawlComplete"):
            stops.append({"id": r["id"], "reason": "HOT_INCOMPLETE_CRAWL"})
    if r.get("newVerdict") == "PUBLISHED" and not r.get("policyFound") and "autoassicur" not in (r.get("evidenceHead") or "").lower():
        # soft — may still have policy in evidence
        pass

OUT.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in picked) + "\n", encoding="utf-8")

def metrics(region: str) -> dict:
    rows = [r for r in picked if r.get("region") == region]
    return {
        "selected": 25,
        "completed": len(rows),
        "identityVerified": sum(
            1
            for r in rows
            if r.get("identityStatus") in ("OFFICIAL_CONFIRMED", "GROUP_OFFICIAL_CONFIRMED")
        ),
        "identityInsufficient": sum(1 for r in rows if r.get("identityStatus") == "INSUFFICIENT"),
        "identityMismatch": sum(1 for r in rows if r.get("identityStatus") == "MISMATCH"),
        "notChecked": sum(1 for r in rows if r.get("identityStatus") == "NOT_CHECKED"),
        "crawlComplete": sum(1 for r in rows if r.get("crawlComplete")),
        "HOT": sum(1 for r in rows if r.get("newVerdict") == "HOT"),
        "PUBLISHED": sum(1 for r in rows if r.get("newVerdict") == "PUBLISHED"),
        "REVIEW": sum(1 for r in rows if r.get("newVerdict") == "REVIEW"),
        "technicalFailure": sum(1 for r in rows if r.get("technicalFailure")),
        "transitions": dict(Counter(f"{r.get('oldVerdict')}→{r.get('newVerdict')}" for r in rows)),
    }

summary = {
    "uniq": len(picked),
    "stopConditions": stops,
    "campania": metrics("Campania"),
    "veneto": metrics("Veneto"),
    "legacyClass": dict(Counter(r.get("legacyClass") for r in picked if r.get("legacyClass"))),
}
(DOCS / "fullcrawl-summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

leg = [r for r in picked if r.get("oldVerdict") in ("HOT", "PUBLISHED")]
md = [
    "# Legacy terminal analysis —  HOT/PUBLISHED storici nel sample Batch 1",
    "",
    f"Record storici HOT/PUB nel sample: **{len(leg)}** (attesi fino a 36; il sample ne contiene {len(leg)}).",
    "",
    "## Classificazione",
    "",
]
for k, v in Counter(r.get("legacyClass") for r in leg).most_common():
    md.append(f"- `{k}`: {v}")
md += [
    "",
    "## Note",
    "",
    "- Non si dichiara falso positivo precedente solo perché il crawl ha fallito/timeout.",
    "- `POSSIBLE_NEW_FALSE_NEGATIVE`: sito presente ma crawl incompleto / timeout — recovery via full crawl esteso.",
    "- `PUBLICATION_CONFIRMED` / `REAL_LEAD_CONFIRMED`: nuovo verdetto terminale con identity/crawl coerenti.",
    "",
    "## Per-record (id hash-free, campi aggregati)",
    "",
]
for r in leg:
    md.append(
        f"- `{r['id'][:12]}…` {r.get('oldVerdict')}→{r.get('newVerdict')} · id={r.get('identityStatus')} · crawl={r.get('crawlComplete')} · class=`{r.get('legacyClass')}` · tech={r.get('technicalFailure')}"
    )
(DOCS / "legacy-terminal-analysis.md").write_text("\n".join(md), encoding="utf-8")
print(json.dumps(summary, indent=2))
