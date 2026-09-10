#!/usr/bin/env bash
set -euo pipefail
LID=cmqmd9ia000979g5c4fd95cmi
URL='https://www.aiasnola.org/wp-content/uploads/2026/03/piano-annuale-risk-management.pdf'
# frontier pdfs
FP=$(python3 - <<PY
import json
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
t=(cp.get('terminal') or {}).get('$LID') or {}
# find frontier from result
r=json.load(open('/opt/leadsniper-revalidate/data/revalidation/results/$LID.json'))
fps=r.get('frontierPaths') or []
print(fps[0] if fps else '')
print('runIds', r.get('runIds'))
PY
)
echo "FRONTIER_INFO $FP"
python3 - <<'PY'
import json, sqlite3, os, re
lid='cmqmd9ia000979g5c4fd95cmi'
r=json.load(open(f'/opt/leadsniper-revalidate/data/revalidation/results/{lid}.json'))
fps=r.get('frontierPaths') or []
fp=fps[0] if fps else None
print('frontier', fp, 'exists', fp and os.path.isfile(fp))
if fp and os.path.isfile(fp):
  con=sqlite3.connect(fp)
  # schema peek
  tables=[x[0] for x in con.execute("SELECT name FROM sqlite_master WHERE type='table'")]
  print('tables', tables)
  for t in tables:
    if 'node' in t.lower() or 'url' in t.lower() or 'pdf' in t.lower() or 'doc' in t.lower():
      cols=[x[1] for x in con.execute(f'PRAGMA table_info({t})')]
      print(t, cols[:20])
  # search aias pdf
  for t in tables:
    try:
      rows=con.execute(f"SELECT * FROM {t} LIMIT 1").fetchone()
    except Exception: continue
    cols=[x[1] for x in con.execute(f'PRAGMA table_info({t})')]
    if not any('url' in c.lower() for c in cols): continue
    urlcol=[c for c in cols if 'url' in c.lower()][0]
    q=f"SELECT {urlcol} FROM {t} WHERE {urlcol} LIKE '%risk%' OR {urlcol} LIKE '%piano%' OR {urlcol} LIKE '%PARS%' OR {urlcol} LIKE '%assicur%' LIMIT 30"
    try:
      for (u,) in con.execute(q):
        print('URL', u)
    except Exception as e:
      print('qerr', t, e)
PY

# download + extract text from known PDF
mkdir -p /tmp/aias-si
cd /tmp/aias-si
curl -fsSL -A 'Mozilla/5.0' -o aias-pars.pdf "$URL" || curl -kfsSL -o aias-pars.pdf "$URL" || true
ls -la aias-pars.pdf 2>/dev/null || echo 'download failed'
pdftotext -layout aias-pars.pdf aias.txt 2>/dev/null || true
wc -c aias.txt 2>/dev/null || true
grep -niE 'autoassicur|gestione diretta|autoritenz|polizza|420172841|posizione assicur' aias.txt 2>/dev/null | head -40 || true
# if empty text, try OCR page sample via pdftoppm
if [[ ! -s aias.txt ]] || [[ $(wc -c < aias.txt) -lt 200 ]]; then
  echo 'PDF mostly scanned — OCR sample'
  pdftoppm -f 1 -l 3 -png -r 150 aias-pars.pdf page 2>/dev/null || true
  for f in page-*.png; do
    [[ -f "$f" ]] || continue
    tesseract "$f" stdout -l ita 2>/dev/null | grep -niE 'autoassicur|gestione diretta|autoritenz|polizza|assicur' | head -10 || true
  done
fi
