#!/usr/bin/env bash
set -euo pipefail

python3 - <<'PY'
import collections
import json
import re
from pathlib import Path

root = Path("/opt/leadsniper-revalidate/data/revalidation")
checkpoint = json.loads((root / "checkpoint.json").read_text())
terminal = checkpoint.get("terminal") or {}
results = root / "results"

def load_result(lead_id):
    path = results / f"{lead_id}.json"
    try:
        return json.loads(path.read_text())
    except Exception:
        return None

hot = []
published = []
review = []
for lead_id, meta in terminal.items():
    state = str(meta.get("processingState") or "")
    row = load_result(lead_id)
    item = (lead_id, meta, row)
    if state == "HOT_VERIFIED":
        hot.append(item)
    elif state.startswith("PUBLISHED") or state == "SELF_INSURANCE_VERIFIED":
        published.append(item)
    elif state in {"REVIEW_HUMAN", "TECHNICAL_BLOCKED"}:
        review.append(item)

def evidence(row):
    return str((row or {}).get("fullEvidence") or (row or {}).get("evidence") or "")

hot_findings = {
    "missing_result": [],
    "crawl_not_complete": [],
    "missing_negative_identity_v2": [],
    "pass1_not_certified": [],
    "missing_pass2": [],
    "pass2_not_certified": [],
    "blocked_marker": [],
    "policy_marker": [],
}
policy_pattern = re.compile(
    r"\[POLICY_FOUND:true\]|\bpolizza\s+(?:n[°º.]?\s*)?"
    r"(?=[A-Z0-9./_-]{5,}\b)(?=[A-Z0-9./_-]*\d)[A-Z0-9][A-Z0-9./_-]+|"
    r"\b(?:Allianz|AmTrust|Generali|UnipolSai|Reale\s+Mutua|Zurich|AXA|"
    r"Groupama|Vittoria\s+Assicurazioni)\b|autoassicurazione\s+(?:deliberata|approvata|fondo)",
    re.I,
)
blocked_pattern = re.compile(
    r"HOT bloccato|pagine insufficienti|CRAWL_COMPLETE:false|\[FRONTIER:OPEN|"
    r"PDF non processati|sitemap .*parzial|cap URL|cap tempo",
    re.I,
)
for lead_id, meta, row in hot:
    if row is None:
        hot_findings["missing_result"].append(lead_id)
        continue
    if row.get("crawlComplete") is not True:
        hot_findings["crawl_not_complete"].append(lead_id)
    if (
        row.get("negativeIdentityCertified") is not True
        or "[NEGATIVE_IDENTITY_V2:1]" not in evidence(row)
    ):
        hot_findings["missing_negative_identity_v2"].append(lead_id)
    pass1 = row.get("pass1")
    if not (
        pass1
        and pass1.get("processingState") == "HOT_VERIFIED"
        and pass1.get("crawlComplete") is True
        and pass1.get("policyFound") is not True
        and pass1.get("negativeIdentityCertified") is True
        and not pass1.get("error")
    ):
        hot_findings["pass1_not_certified"].append(lead_id)
    pass2 = row.get("pass2")
    if not pass2:
        hot_findings["missing_pass2"].append(lead_id)
    elif not (
        pass2.get("processingState") == "HOT_VERIFIED"
        and pass2.get("crawlComplete") is True
        and pass2.get("policyFound") is not True
        and pass2.get("negativeIdentityCertified") is True
        and not pass2.get("error")
    ):
        hot_findings["pass2_not_certified"].append(lead_id)
    text = evidence(row)
    if blocked_pattern.search(text):
        hot_findings["blocked_marker"].append(lead_id)
    if row.get("policyFound") is True or row.get("policyNumber") or policy_pattern.search(text):
        hot_findings["policy_marker"].append(lead_id)

published_findings = {
    "missing_result": [],
    "crawl_not_complete": [],
    "policy_not_true": [],
    "missing_isolated_attribution": [],
    "no_policy_number_or_si": [],
}
for lead_id, meta, row in published:
    if row is None:
        published_findings["missing_result"].append(lead_id)
        continue
    if row.get("crawlComplete") is not True:
        published_findings["crawl_not_complete"].append(lead_id)
    state = str(meta.get("processingState") or "")
    if state.startswith("PUBLISHED") and row.get("policyFound") is not True:
        published_findings["policy_not_true"].append(lead_id)
    if (
        row.get("entityAttributionCertified") is not True
        or "[ATTR_RESOURCE_ISOLATED:1]" not in evidence(row)
    ):
        published_findings["missing_isolated_attribution"].append(lead_id)
    if (
        state.startswith("PUBLISHED")
        and not row.get("policyNumber")
        and not re.search(r"\bautoassicur|SELF_INSURANCE", evidence(row), re.I)
    ):
        published_findings["no_policy_number_or_si"].append(lead_id)

review_reasons = collections.Counter(
    str((row or {}).get("reasonCode") or meta.get("reasonCode") or meta.get("processingState"))
    for _, meta, row in review
)

report = {
    "checkpoint": {
        "terminal": len(terminal),
        "retry": len(checkpoint.get("retryQueue") or {}),
        "inProgress": len(checkpoint.get("inProgress") or {}),
    },
    "hot": {
        "total": len(hot),
        "row_fields": {
            "policyFound_true": sum(1 for _, _, row in hot if (row or {}).get("policyFound") is True),
            "policyNumber_nonempty": sum(1 for _, _, row in hot if (row or {}).get("policyNumber")),
            "policyCompany_nonempty": sum(1 for _, _, row in hot if (row or {}).get("policyCompany")),
        },
        "findings": {key: len(value) for key, value in hot_findings.items()},
        "samples": {key: value[:10] for key, value in hot_findings.items() if value},
    },
    "published_or_si": {
        "total": len(published),
        "findings": {key: len(value) for key, value in published_findings.items()},
        "samples": {key: value[:10] for key, value in published_findings.items() if value},
    },
    "review_or_tech": {
        "total": len(review),
        "reasons": dict(review_reasons),
    },
    "uncertified_hot_details": [
        {
            "id": lead_id,
            "companyName": (row or {}).get("companyName"),
            "website": (row or {}).get("website"),
            "reasonCode": (row or {}).get("reasonCode"),
            "pagesVisited": (row or {}).get("pagesVisited"),
            "frontierPath": ((row or {}).get("frontierPaths") or [None])[-1],
            "evidenceHead": evidence(row)[:500],
        }
        for lead_id, _, row in hot
        if lead_id in hot_findings["missing_pass2"]
    ],
    "hot_policy_signal_details": [
        {
            "id": lead_id,
            "companyName": (row or {}).get("companyName"),
            "website": (row or {}).get("website"),
            "match": (policy_pattern.search(evidence(row)).group(0) if policy_pattern.search(evidence(row)) else None),
            "evidenceHead": evidence(row)[:1200],
        }
        for lead_id, _, row in hot
        if lead_id in hot_findings["policy_marker"]
    ],
    "published_details": [
        {
            "id": lead_id,
            "state": meta.get("processingState"),
            "companyName": (row or {}).get("companyName"),
            "website": (row or {}).get("website"),
            "crawlComplete": (row or {}).get("crawlComplete"),
            "policyFound": (row or {}).get("policyFound"),
            "policyCompany": (row or {}).get("policyCompany"),
            "policyNumber": (row or {}).get("policyNumber"),
            "policyExpiry": (row or {}).get("policyExpiry"),
            "reasonCode": (row or {}).get("reasonCode"),
            "evidenceHead": evidence(row)[:900],
        }
        for lead_id, meta, row in published
    ],
}
print(json.dumps(report, ensure_ascii=False, indent=2))
PY
