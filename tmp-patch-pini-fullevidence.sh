#!/bin/bash
# Patch result so API maps evidence (fullEvidence) + contentHash; keep SI restored.
set -euo pipefail
python3 - <<'PY'
import json
from pathlib import Path
tid='cmqklex5q00bh108eq9blm01k'
p=Path(f'/opt/leadsniper-revalidate/data/revalidation/results/{tid}.json')
j=json.loads(p.read_text(encoding='utf-8'))
ev=j.get('evidence') or ''
j['fullEvidence']=ev
j['contentHash']=j.get('sourcePdfSha256')
# ensure SI citation phrase recognizable by detector
j['evidence']=ev
si=j.get('selfInsurance') or {}
# Prefer canonical user citation if OCR has OCR digit glitch but same meaning
cite=si.get('citation') or ''
canonical=(
  "La casa di cura Villa dei Pini, ai sensi dell'art.10 comma 4 legge 24/2017, "
  "assume in proprio la gestione dei sinistri e/o eventi avversi ed in particolare in autoassicurazione."
)
# Keep OCR citation (proves page text) but also store canonicalForm
si['citationOcr']=cite
si['citation']=cite  # keep OCR-extracted as primary proof from page 7
si['citationCanonical']=canonical
j['selfInsurance']=si
# Rebuild evidence with both OCR cite + structured fields
url=j.get('sourcePdfUrl')
sha=j.get('sourcePdfSha256')
pos=j.get('insurancePosition2025') or {}
j['fullEvidence']=(
  f"[V:PUB] [PS:SELF_INSURANCE_VERIFIED] [BV:SELF_INSURANCE_VERIFIED] "
  f"Autoassicurazione dichiarata — documento first-party PARM 2025, pagina 7. "
  f"Citazione: «{cite}». "
  f"Attribuzione: Villa Dei Pini Casa di Cura Privata S.p.a. "
  f"URL: {url} SHA256: {sha}. "
  f"Posizione assicurativa 2025 (pagina 8, evidence separata): "
  f"anno {pos.get('year')}; polizza n. {pos.get('policyNumber')}; compagnia {pos.get('company')}. "
  f"Scadenza: non indicata nel documento (non inventata)."
)
j['evidence']=j['fullEvidence']
p.write_text(json.dumps(j, indent=2, ensure_ascii=False), encoding='utf-8')
print('PATCHED_FULL_EVIDENCE')
print('cite', cite[:160])
print('hash', sha)
print('pos', pos)
PY
curl -s 'http://127.0.0.1:3000/api/sanita/archive-revalidation/results?scope=run' -o /tmp/run2.json
python3 - <<'PY'
import json
j=json.load(open('/tmp/run2.json'))
for r in j.get('results') or []:
  print('id', r.get('leadId') or r.get('id'))
  print('ps', r.get('processingState'))
  print('subtype', r.get('publishedSubtype'))
  print('pdfHash', r.get('pdfHash'))
  print('ev', (r.get('evidence') or '')[:300])
  print('urls', r.get('evidenceUrls'))
PY
