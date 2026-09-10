#!/usr/bin/env bash
set -uo pipefail
LID=cmqoaraqo0039aa3vjlus8ef6
CP=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json

python3 - "$LID" <<'PY' > /tmp/identity-real-input.json
import glob, json, os, sqlite3, sys
lid = sys.argv[1]
# lead identity from live DB
con = sqlite3.connect("file:/opt/leadsniper/prisma/dev.db?mode=ro", uri=True)
row = con.execute(
    "select companyName, website, city, region from Lead where id=?", (lid,)
).fetchone()
name, web, city, region = row if row else (None, None, None, None)

# crawl corpus from newest frontier evidence
files = sorted(
    glob.glob(f"/opt/leadsniper-revalidate/data/revalidation/frontiers/*{lid}*.sqlite"),
    key=os.path.getmtime,
    reverse=True,
)
corpus, pages = "", []
for f in files[:2]:
    try:
        c = sqlite3.connect(f"file:{f}?mode=ro", uri=True)
        tbls = [r[0] for r in c.execute("select name from sqlite_master where type='table'")]
        evt = next((t for t in tbls if "evidence" in t.lower()), None)
        nodet = next((t for t in tbls if "node" in t.lower()), None)
        if evt:
            cols = [r[1] for r in c.execute(f"pragma table_info({evt})")]
            tcol = next((x for x in cols if "normalizedtext" in x.lower() or x.lower() == "text"), None)
            ucol = next((x for x in cols if "url" in x.lower()), None)
            if tcol:
                for r in c.execute(f"select {tcol}{',' + ucol if ucol else ''} from {evt} limit 40"):
                    corpus += " " + (r[0] or "")
                    if ucol and len(r) > 1 and r[1]:
                        pages.append(r[1])
        if nodet and not pages:
            cols = [r[1] for r in c.execute(f"pragma table_info({nodet})")]
            ucol = next((x for x in cols if "canonicalurl" in x.lower() or "url" in x.lower()), None)
            if ucol:
                pages = [r[0] for r in c.execute(f"select {ucol} from {nodet} limit 60")]
        c.close()
    except Exception as e:
        print("ERR", f, e, file=sys.stderr)
    if len(corpus) > 5000:
        break

json.dump(
    {
        "companyName": name,
        "website": web,
        "city": city,
        "region": region,
        "corpus": corpus[:60000],
        "pagesVisited": pages[:60],
        "corpus_len": len(corpus),
    },
    sys.stdout,
    ensure_ascii=False,
)
PY

echo "--- lead ---"
python3 -c "import json;d=json.load(open('/tmp/identity-real-input.json'));print(d['companyName'],'|',d['website'],'|',d['city'],'| corpus_len',d['corpus_len'],'| pages',len(d['pagesVisited']))"

cd /opt/leadsniper-revalidate/app
npx --yes tsx -e '
import fs from "node:fs";
import { validateSiteIdentity, companyNameOnSite } from "./src/lib/sanita/site-identity.ts";
import { hostBrandMatchesName } from "./src/lib/sanita/contacts.ts";
const d = JSON.parse(fs.readFileSync("/tmp/identity-real-input.json", "utf8"));
const crawl = {
  ok: true,
  text: d.corpus,
  policyText: "",
  pagesVisited: d.pagesVisited,
  foundRelevantPage: true,
  policyPdfUrl: null,
  policyPdfsRead: 0,
  policyPdfsQueued: 0,
};
console.log(JSON.stringify({
  company: d.companyName,
  website: d.website,
  city: d.city,
  nameOnSite: companyNameOnSite(d.companyName ?? "", d.corpus),
  hostBrandMatch: hostBrandMatchesName(d.companyName ?? "", d.website ?? ""),
  identity: validateSiteIdentity(d.companyName ?? "", d.website ?? "", crawl, d.city),
}, null, 2));
'
