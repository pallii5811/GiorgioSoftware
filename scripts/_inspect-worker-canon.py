#!/usr/bin/env python3
import re, json
p="/opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker.mjs"
t=open(p,encoding="utf-8",errors="replace").read()
out={}
out["imports_acceptCanonicalPublishedTerminal"]= "acceptCanonicalPublishedTerminal" in t
out["has_scadut"]= bool(re.search(r"scadut", t, re.I))
out["has_policyObsolete"]= bool(re.search(r"policyObsolete", t))
# banned: invent PUBLISHED_EXPIRED from prose
out["banned_regex_promo"]= bool(re.search(r"scadut[aeo].{0,200}PUBLISHED_EXPIRED|PUBLISHED_EXPIRED.{0,200}\[DOCS", t, re.I|re.S))
# look for assignment of PUBLISHED without acceptCanonical nearby
suspicious=[]
for i,l in enumerate(t.splitlines(),1):
    if re.search(r"processingState\s*[:=]\s*[\"']PUBLISHED", l):
        suspicious.append({"line":i,"text":l.strip()[:200]})
    if re.search(r"newVerdict\s*[:=]\s*[\"']PUBLISHED", l) and "acceptCanonical" not in l:
        suspicious.append({"line":i,"text":l.strip()[:200]})
out["suspicious_assignments"]=suspicious
# identity mismatch handling
out["identity_review_human"]= bool(re.search(r"IDENTITY|identityMismatch|REVIEW_HUMAN", t))
# RETRY for non-canonical published
out["retry_non_canonical"]= bool(re.search(r"RETRY_PENDING", t)) and bool(re.search(r"acceptCanonicalPublishedTerminal", t))
# print acceptCanonical block
lines=t.splitlines()
blocks=[]
for i,l in enumerate(lines):
    if "acceptCanonicalPublishedTerminal" in l:
        blocks.append("\n".join(f"{j+1}: {lines[j]}" for j in range(max(0,i-2), min(len(lines), i+25))) )
out["accept_blocks"]=blocks[:3]
print(json.dumps(out, indent=2))
