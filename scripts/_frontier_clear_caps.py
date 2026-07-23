#!/usr/bin/env python3
import sqlite3, sys
fp = sys.argv[1]
con = sqlite3.connect(fp)
con.execute("UPDATE CrawlRun SET state='RUNNING', urlCapReached=0, timeCapReached=0, workerLock=NULL")
con.commit()
print("ok")
