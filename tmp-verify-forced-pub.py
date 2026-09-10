#!/usr/bin/env python3
import json
cp=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
for lid in ["cmqma6d8e000q9g5crb0tkxag","cmqmctogz008i9g5ctaoy1ii1"]:
  t=cp["terminal"][lid]
  r=json.load(open(f"/opt/leadsniper-revalidate/data/revalidation/results/{lid}.json"))
  print(json.dumps({
    "id": lid,
    "term": t.get("processingState"),
    "reason": t.get("reasonCode"),
    "pf": r.get("policyFound"),
    "num": r.get("policyNumber"),
    "co": r.get("policyCompany"),
    "in_retry": lid in (cp.get("retryQueue") or {}),
  }, ensure_ascii=False))
assert cp["terminal"]["cmqma6d8e000q9g5crb0tkxag"]["processingState"].startswith("PUBLISHED")
assert cp["terminal"]["cmqmctogz008i9g5ctaoy1ii1"]["processingState"].startswith("PUBLISHED")
print("PUBLISH_OK")
