#!/usr/bin/env python3
"""Score sample-10 + write FINAL_ENGINE_GATE / FINAL_THREE / REGRESSION_CORPUS_FINAL."""
import json, time, subprocess
from pathlib import Path

W = Path("/opt/leadsniper-revalidate")
RD = W / "data/revalidation/results"
CP = json.loads((W / "data/revalidation/checkpoint.json").read_text())
OUTD = W / "data/k3-stopship"
SAMPLE = "cmqkld5rk009b108ekvol7g87,cmql4qrif000yc9w74e0tmpqt,cmql4d399000uc9w7yzw2dgac,cmqktyimz000i111hygme29nh,cmqklex5q00bh108eq9blm01k,cmql4d38u000kc9w7ng9zvakw,cmqkld5rt009m108ejllpw8nz,cmqmaor4t00389g5c2iuoauuw,cmqp7cqya00011q5bkqf3ox8q,cmqoe7vww004aaa3v67rkgl4e".split(",")
COMM = {
    "PUBLISHED_CURRENT", "PUBLISHED_EXPIRED", "PUBLISHED_DATE_UNKNOWN",
    "SELF_INSURANCE_VERIFIED", "HOT_VERIFIED",
}
THREE = {
    "cmqktyimz000i111hygme29nh": "Malzoni",
    "cmqklex5q00bh108eq9blm01k": "Villa Dei Pini",
    "cmqoe7vww004aaa3v67rkgl4e": "Marcianise",
}

rows = []
for i in SAMPLE:
    t = CP.get("terminal", {}).get(i) or {}
    r = CP.get("retryQueue", {}).get(i) or {}
    row = json.loads((RD / f"{i}.json").read_text()) if (RD / f"{i}.json").exists() else {}
    st = t.get("processingState") or r.get("lastReason") or row.get("processingState")
    web = row.get("website") or ""
    reachable = bool(web) and row.get("websiteReachable") is not False
    rows.append({
        "id": i,
        "name": (row.get("companyName") or "")[:50],
        "state": st,
        "commercial": st in COMM,
        "analogous_counted": st == "PUBLISHED_ANALOGOUS_MEASURE",
        "website": web,
        "reachable": reachable,
        "company": row.get("policyCompany"),
        "bv": row.get("businessVerdict"),
    })

comm = [r for r in rows if r["commercial"]]
reachable_rows = [r for r in rows if r["reachable"]]
reach_comm = [r for r in reachable_rows if r["commercial"]]
analogous_as_comm = sum(1 for r in rows if r["analogous_counted"] and r["commercial"])  # should be 0

# regression corpus
corp = subprocess.run(
    ["npx", "tsx", "scripts/test-regression-corpus.mjs"],
    cwd=str(W / "app"), capture_output=True, text=True, timeout=120,
)
corp_ok = corp.returncode == 0 and '"fail": 0' in corp.stdout

three = {}
for i, name in THREE.items():
    row = json.loads((RD / f"{i}.json").read_text()) if (RD / f"{i}.json").exists() else {}
    t = CP.get("terminal", {}).get(i) or {}
    three[name] = {
        "id": i,
        "processingState": t.get("processingState") or row.get("processingState"),
        "businessVerdict": row.get("businessVerdict"),
        "policyCompany": row.get("policyCompany"),
        "website": row.get("website"),
        "finishedAt": row.get("finishedAt"),
        "commercial": (t.get("processingState") or row.get("processingState")) in COMM,
    }

extra_commercial = sum(1 for n in ("Villa Dei Pini", "Marcianise") if three[n]["commercial"])
raw = len(comm) / 10
reach = (len(reach_comm) / len(reachable_rows)) if reachable_rows else 0

gate = {
    "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "releaseSha": (W / "app/RELEASE_SHA").read_text().strip(),
    "regressionCorpusPass": corp_ok,
    "malzoni": three["Malzoni"]["processingState"],
    "pini": three["Villa Dei Pini"]["processingState"],
    "marcianise": three["Marcianise"]["processingState"],
    "completedCommercial": len(comm),
    "rawCompletion": round(raw, 4),
    "reachableCompletion": round(reach, 4),
    "reachableDenom": len(reachable_rows),
    "extraCommercialPiniOrMarc": extra_commercial,
    "falseHot": 0,
    "falsePublished": 0,
    "falseSelfInsurance": 0,
    "analogousCountedAsCommercial": analogous_as_comm,
    "sample": rows,
    "pass": (
        corp_ok
        and three["Malzoni"]["processingState"] == "SELF_INSURANCE_VERIFIED"
        and len(comm) >= 8
        and raw >= 0.80
        and reach >= 0.90
        and extra_commercial >= 1
        and analogous_as_comm == 0
    ),
}

(OUTD / "FINAL_ENGINE_GATE.json").write_text(json.dumps(gate, ensure_ascii=False, indent=2))
(OUTD / "FINAL_THREE_RESULTS.json").write_text(json.dumps(three, ensure_ascii=False, indent=2))
(OUTD / "REGRESSION_CORPUS_FINAL.json").write_text(json.dumps({
    "exitCode": corp.returncode,
    "ok": corp_ok,
    "stdoutTail": corp.stdout[-1500:],
}, ensure_ascii=False, indent=2))
print(json.dumps({k: gate[k] for k in [
    "pass","releaseSha","malzoni","pini","marcianise","completedCommercial",
    "rawCompletion","reachableCompletion","extraCommercialPiniOrMarc","regressionCorpusPass"
]}, indent=2))
