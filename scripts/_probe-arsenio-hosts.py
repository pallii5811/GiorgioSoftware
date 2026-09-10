#!/usr/bin/env python3
import socket
from urllib.request import urlopen, Request

for h in [
    "santarseniomedicalcentre.com",
    "www.santarseniomedicalcentre.com",
    "santarseniomedicalcentre.it",
    "www.santarseniomedicalcentre.it",
]:
    try:
        print(h, socket.getaddrinfo(h, 443)[0][4])
    except Exception as e:
        print(h, "DNS_FAIL", type(e).__name__, e)

for u in [
    "http://www.santarseniomedicalcentre.it/",
    "https://www.santarseniomedicalcentre.it/",
    "https://santarseniomedicalcentre.it/",
]:
    try:
        r = urlopen(Request(u, headers={"User-Agent": "k3"}), timeout=15)
        print("FETCH", u, "->", r.geturl(), r.status)
    except Exception as e:
        print("FETCH", u, "ERR", e)
