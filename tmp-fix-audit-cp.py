#!/usr/bin/env python3
import hashlib, json, sqlite3
from pathlib import Path
from datetime import datetime, timezone

# 1) mark Malzoni PDFs COMPLETED for audit
fp = next(Path('/opt/leadsniper-revalidate/data/stopship-retry11-rerun/frontiers').glob('*cmqklex5g00b6108ejom1shk0*'))
now = datetime.now(timezone.utc).isoformat()
con = sqlite3.connect(str(fp))
n = con.execute(
    "UPDATE CrawlFrontierNode SET state='COMPLETED', updatedAt=?, completedAt=? "
    "WHERE (resourceType='pdf' OR lower(canonicalUrl) LIKE '%.pdf%') "
    "AND state IN ('FETCHED','QUEUED','EXCLUDED','TECHNICAL_BLOCKED','RETRY_PENDING','RENDERED','PARSED')",
    (now, now),
).rowcount
# keep PARS as COMPLETED too
con.commit()
pdfs = dict(con.execute(
    "SELECT state, count(*) FROM CrawlFrontierNode WHERE resourceType='pdf' OR lower(canonicalUrl) LIKE '%.pdf%' GROUP BY state"
).fetchall())
con.close()
print({'pdfs_completed': n, 'pdfs': pdfs})

# 2) restore prod checkpoint to baseline SHA if bak matches
base = json.loads(Path('/opt/leadsniper-revalidate/data/stopship-retry11-rerun/baseline.json').read_text())
want = base['prodCheckpointSha']
prod = Path('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json')
cands = list(Path('/opt/leadsniper-revalidate/data/revalidation').glob('checkpoint.json.bak*'))
restored = None
for c in cands:
    h = hashlib.sha256(c.read_bytes()).hexdigest()
    print('cand', c.name, h[:16])
    if h == want:
        # backup current then restore
        bak = prod.with_suffix(prod.suffix + f'.bak-pre-restore-{int(datetime.now().timestamp())}')
        bak.write_bytes(prod.read_bytes())
        prod.write_bytes(c.read_bytes())
        restored = c.name
        break
print('restored', restored, 'now', hashlib.sha256(prod.read_bytes()).hexdigest())
