#!/usr/bin/env python3
"""Identity: dominio first-party + contenuti sanitari = identità confermata.
Sblocca i falsi IDENTITY_MISMATCH senza accettare domini estranei (delta.com, trieste.com)."""
from pathlib import Path

TARGETS = [
    Path("/opt/leadsniper-revalidate/app/src/lib/sanita/site-identity.ts"),
    Path("/opt/leadsniper/src/lib/sanita/site-identity.ts"),
]

IMPORT_ANCHOR = 'import { mapsNameVariants, mapsNamesMatch } from "@/lib/sanita/maps-query";'
IMPORT_ADD = 'import { hostBrandMatchesName } from "@/lib/sanita/contacts";'

NAME_GATE_OLD = """  if (!companyNameOnSite(companyName, corpus)) {
    return {
      ok: false,
      reason: "Nome struttura assente nel sito analizzato — probabile sito errato (omonimia Maps)",
    };
  }"""

NAME_GATE_NEW = """  // Dominio first-party + contenuti sanitari: l'host stesso prova l'identità
  // (nome spesso solo in logo/immagini). Domini estranei (delta.com, trieste.com)
  // restano bloccati perché senza corpus sanitario.
  const brandHostHealthSite =
    hostBrandMatchesName(companyName, website) && HEALTH_CORPUS.test(corpus);

  if (!brandHostHealthSite && !companyNameOnSite(companyName, corpus)) {
    return {
      ok: false,
      reason: "Nome struttura assente nel sito analizzato — probabile sito errato (omonimia Maps)",
    };
  }"""

CITY_GATE_OLD = "  if (!cityOnSite(city, corpus)) {"
CITY_GATE_NEW = "  if (!brandHostHealthSite && !cityOnSite(city, corpus)) {"


def patch(path: Path) -> None:
    raw = path.read_bytes()
    nl = "\r\n" if b"\r\n" in raw else "\n"
    s = raw.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")

    if "brandHostHealthSite" in s:
        print("ALREADY", path)
        return

    if IMPORT_ADD not in s:
        if IMPORT_ANCHOR not in s:
            raise SystemExit(f"IMPORT_ANCHOR_FAIL {path}")
        s = s.replace(IMPORT_ANCHOR, IMPORT_ANCHOR + "\n" + IMPORT_ADD, 1)

    if NAME_GATE_OLD not in s:
        raise SystemExit(f"NAME_GATE_FAIL {path}")
    s = s.replace(NAME_GATE_OLD, NAME_GATE_NEW, 1)

    if s.count(CITY_GATE_OLD) != 1:
        raise SystemExit(f"CITY_GATE_COUNT {s.count(CITY_GATE_OLD)} {path}")
    s = s.replace(CITY_GATE_OLD, CITY_GATE_NEW, 1)

    path.write_bytes(s.replace("\n", nl).encode("utf-8"))
    print("PATCHED", path)


for p in TARGETS:
    if p.exists():
        patch(p)
print("DONE")
