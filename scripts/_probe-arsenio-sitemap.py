#!/usr/bin/env python3
from urllib.request import Request, urlopen

base = "https://santarseniomedicalcentre.it"
for path in ["/robots.txt", "/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml"]:
    u = base + path
    try:
        r = urlopen(Request(u, headers={"User-Agent": "k3"}), timeout=20)
        body = r.read(500)
        print(path, r.status, r.geturl(), body[:200])
    except Exception as e:
        print(path, "ERR", e)
