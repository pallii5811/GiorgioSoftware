#!/usr/bin/env python3
import json
ids = {
  "cmqkld5rk009b108ekvol7g87": "Montevergine",
  "cmql4qrif000yc9w74e0tmpqt": "VillaFelice",
  "cmql4d399000uc9w7yzw2dgac": "Grimaldi",
  "cmqktyimz000i111hygme29nh": "Malzoni",
  "cmqklex5q00bh108eq9blm01k": "VillaDeiPini",
  "cmql4d38u000kc9w7ng9zvakw": "AnniSereni",
  "cmqkld5rt009m108ejllpw8nz": "SanPaolo",
  "cmqmaor4t00389g5c2iuoauuw": "VillaFormosa",
  "cmqp7cqya00011q5bkqf3ox8q": "SantArsenio",
  "cmqoe7vww004aaa3v67rkgl4e": "Marcianise",
}
cp = json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
term = cp.get("terminal") or {}
for i, n in ids.items():
  v = term.get(i)
  ps = v.get("processingState") if isinstance(v, dict) else v
  print(f"{n}: {ps or 'NOT_IN_TERMINAL'}")
print("counts", {k: len(cp.get(k) or {}) for k in ["terminal", "inProgress", "retryQueue"]})
print("updatedAt", cp.get("updatedAt"))
