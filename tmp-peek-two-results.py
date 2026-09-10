#!/usr/bin/env python3
import json
from pathlib import Path
T=Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun")
for lid, name in [("cmqmaf02a001k9g5crmkdun0w","Medicanova"),("cmqklex5g00b6108ejom1shk0","Malzoni")]:
  rp=T/"results"/f"{lid}.json"
  row={}
  if rp.exists():
    row=json.loads(rp.read_text())
  ev=(row.get("fullEvidence") or row.get("evidence") or "")[:600]
  print("===", name, lid)
  print(json.dumps({
    "processingState": row.get("processingState"),
    "reasonCode": row.get("reasonCode"),
    "crawlComplete": row.get("crawlComplete"),
    "policyFound": row.get("policyFound"),
    "businessVerdict": row.get("businessVerdict"),
    "newVerdict": row.get("newVerdict"),
    "dual": row.get("dualDisagreement"),
    "errorClass": row.get("errorClass"),
    "si_in_ev": bool(__import__("re").search(r"autoassicura|gestione diretta|fondo rischi|SELF_INSURANCE", ev, __import__("re").I)),
    "ev_snip": ev[:400],
  }, indent=2, ensure_ascii=False))
