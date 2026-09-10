import json
from collections import Counter

g = json.load(open("data/k3-stopship/RETRY20_GATE.json", encoding="utf-8"))
print("terminalized", g["terminalized"], "blocked", g["externalBlocked"], "pass", g["pass"])
print("term", g["terminalBefore"], "->", g["terminalAfter"], "retry", g["retryBefore"], "->", g["retryAfter"])
c = Counter()
for r in g["rows"]:
    k = r.get("finalKind")
    e = r.get("finalError") or r.get("initialError") or "?"
    st = r.get("finalState")
    name = (r.get("companyName") or "")[:40]
    print(f"{k}\t{st}\t{e}\t{name}\twall={r.get('wallMs')}")
    if k == "retry":
        c[str(e)] += 1
print("retry_errors", c.most_common())
