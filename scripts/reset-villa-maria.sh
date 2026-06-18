#!/bin/bash
sqlite3 /opt/leadsniper/prisma/dev.db "UPDATE Lead SET lastScannedAt=NULL, website=NULL WHERE region='Campania' AND companyName LIKE '%Villa Maria%'; SELECT changes();"
