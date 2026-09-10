#!/usr/bin/env python3
import sqlite3
from pathlib import Path
fp=next(Path('/opt/leadsniper-revalidate/data/stopship-retry11-rerun/frontiers').glob('*cmqklex5g00b6108ejom1shk0*'))
con=sqlite3.connect(str(fp))
print('NODE', con.execute('PRAGMA table_info(CrawlFrontierNode)').fetchall())
print('EV', con.execute('PRAGMA table_info(CrawlNodeEvidence)').fetchall())
# sample insertable
print(con.execute('SELECT * FROM CrawlFrontierNode LIMIT 1').fetchone())
con.close()
