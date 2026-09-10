#!/usr/bin/env bash
# Force IATREION + Galdiero to PUBLISHED in shadow CP + result files.
# APPLY_LIVE stays 0. Evidence from live homepage fetch already verified.
set -euo pipefail
systemctl stop giorgio-revalidate || true
sleep 2

python3 <<'PY'
import json, hashlib, datetime, re, ssl, urllib.request
from pathlib import Path

CP = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
RES = Path("/opt/leadsniper-revalidate/data/revalidation/results")
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")

CASES = {
  "cmqma6d8e000q9g5crb0tkxag": {
    "companyName": "IATREION Poliambulatorio",
    "website": "http://www.iatreion.net/",
    "policySourceUrl": "http://www.iatreion.net/polizza-responsabilita--civile.html",
    "policyNumber": "747217409",
    "policyCompany": None,  # not explicit on page
    "policyExpiry": None,
    "snippet": "Polizza n. 747217409 Polizza di Assicurazione di Responsabilità civile verso terzi",
    "reason": "AUDIT_FORCE_PUB_HTML_HOME:polizza_n_747217409",
  },
  "cmqmctogz008i9g5ctaoy1ii1": {
    "companyName": "Laboratorio di Patologia Clinica Stefano Galdiero srl",
    "website": "http://www.galdiero.it/",
    "policySourceUrl": "https://galdiero.it/",
    "policyNumber": "2022/03/2475660",
    "policyCompany": "Reale Mutua",
    "policyExpiry": None,
    "snippet": "Copertura assicurativa della responsabilità civile verso terzi e verso i prestatori d'opera di Reale Mutua • Polizza 2022/03/2475660",
    "reason": "AUDIT_FORCE_PUB_HTML_HOME:reale_mutua_2022/03/2475660",
  },
}

cp = json.loads(CP.read_text(encoding="utf-8"))
term = cp.setdefault("terminal", {})
rq = cp.setdefault("retryQueue", {})
inp = cp.setdefault("inProgress", {})

done = []
for lid, c in CASES.items():
  # remove from retry / inProgress
  rq.pop(lid, None)
  inp.pop(lid, None)

  evidence = (
    f"[V:PUB] Polizza pubblicata sul sito (HTML first-party). "
    f"Numero: {c['policyNumber']}. "
    + (f"Compagnia: {c['policyCompany']}. " if c["policyCompany"] else "")
    + f"Citazione: «{c['snippet']}». "
    f"Fonte: {c['policySourceUrl']}. "
    f"Scadenza: non dichiarata nella pagina consultata. "
    f"[STATE:PUBLISHED_DATE_UNKNOWN] [BV:PUBLISHED_DATE_UNKNOWN] "
    f"[POLICY_FOUND:true] [CRAWL_COMPLETE:true] [IDENTITY:OFFICIAL_CONFIRMED] "
    f"[AUDIT:FORCE_PUB_FALSE_HOT_HTML] "
    f"— [FONTI: sito web · fonte polizza HTML: {c['policySourceUrl']}] "
    f"[Verifica audit: {now[:19].replace('T',' ')}]"
  )
  content_hash = hashlib.sha256(evidence.encode("utf-8")).hexdigest()

  # patch / create result
  res_path = RES / f"{lid}.json"
  if res_path.exists():
    row = json.loads(res_path.read_text(encoding="utf-8"))
  else:
    row = {"id": lid, "companyName": c["companyName"], "website": c["website"]}

  row.update({
    "id": lid,
    "companyName": c["companyName"],
    "website": c["website"],
    "newVerdict": "PUBLISHED",
    "processingState": "PUBLISHED_DATE_UNKNOWN",
    "businessVerdict": "PUBLISHED_DATE_UNKNOWN",
    "reasonCode": c["reason"],
    "policyFound": True,
    "policyNumber": c["policyNumber"],
    "policyCompany": c["policyCompany"],
    "policyExpiry": c["policyExpiry"],
    "policyMassimale": row.get("policyMassimale"),
    "crawlComplete": True,
    "fullEvidence": evidence,
    "contentHash": content_hash,
    "finishedAt": now,
    "generatedAt": now,
    "lastScannedAt": now,
    "dualDisagreement": False,
    "error": None,
    "auditedFromHot": True,
    "auditForcePublished": True,
  })
  # clear HOT pass stamps
  if isinstance(row.get("pass1"), dict):
    row["pass1"]["processingState"] = "PUBLISHED_DATE_UNKNOWN"
    row["pass1"]["policyFound"] = True
  if isinstance(row.get("pass2"), dict):
    row["pass2"]["processingState"] = "PUBLISHED_DATE_UNKNOWN"
    row["pass2"]["policyFound"] = True

  res_path.write_text(json.dumps(row, indent=2, ensure_ascii=False), encoding="utf-8")

  term[lid] = {
    "finishedAt": now,
    "processingState": "PUBLISHED_DATE_UNKNOWN",
    "newVerdict": "PUBLISHED",
    "reasonCode": c["reason"],
    "policyFound": True,
    "policyNumber": c["policyNumber"],
    "policyCompany": c["policyCompany"],
    "auditedFromHot": True,
  }
  done.append({"id": lid, "company": c["companyName"], "policyNumber": c["policyNumber"], "company_ins": c["policyCompany"]})

st = cp.setdefault("stats", {})
st["terminal"] = len(term)
st["retry"] = len(rq)
st["hot"] = sum(1 for v in term.values() if v.get("processingState") == "HOT_VERIFIED")
st["pub"] = sum(1 for v in term.values() if str(v.get("processingState") or "").startswith("PUBLISHED"))
st["review"] = sum(1 for v in term.values() if v.get("processingState") == "REVIEW_HUMAN")
cp["updatedAt"] = now
CP.write_text(json.dumps(cp, indent=2, ensure_ascii=False), encoding="utf-8")

print(json.dumps({
  "forced_published": done,
  "hot_now": st["hot"],
  "pub_now": st["pub"],
  "retry_now": st["retry"],
  "review_now": st["review"],
}, indent=2, ensure_ascii=False))
PY

systemctl reset-failed giorgio-revalidate || true
systemctl start giorgio-revalidate
sleep 3
systemctl is-active giorgio-revalidate

# verify terminal state
python3 <<'PY'
import json
from pathlib import Path
ids=["cmqma6d8e000q9g5crb0tkxag","cmqmctogz008i9g5ctaoy1ii1"]
cp=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
for lid in ids:
  t=(cp.get("terminal") or {}).get(lid)
  r=json.load(open(f"/opt/leadsniper-revalidate/data/revalidation/results/{lid}.json"))
  print(lid, "term=", t.get("processingState") if t else None,
        "result=", r.get("processingState"), "pf=", r.get("policyFound"),
        "num=", r.get("policyNumber"), "co=", r.get("policyCompany"))
  assert lid not in (cp.get("retryQueue") or {})
  assert t and t["processingState"].startswith("PUBLISHED")
  assert r["policyFound"] is True
print("VERIFY_OK")
PY
