#!/usr/bin/env python3
"""Line-based surgical patch — no fragile multi-line regex."""
from pathlib import Path

def patch_detector(path: Path) -> None:
    raw = path.read_bytes()
    nl = "\r\n" if b"\r\n" in raw else "\n"
    lines = raw.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n").split("\n")

    text = "\n".join(lines)
    if "htmlPolicyNumberRc" in text and "Polizza 2022/03" in text:
        print("ALREADY", path)
        return

    # Insert YYYY/MM pattern after the polizza n[...] line
    if "Polizza 2022/03" not in text:
        for i, line in enumerate(lines):
            if "/polizza\\s+n[" in line and "[A-Z0-9_./-]{4,}" in line:
                # next non-empty should be polizza digits pattern
                lines.insert(i + 1, '    // HTML footer/home: "Polizza 2022/03/2475660" (senza "n.")')
                lines.insert(i + 2, r"    /polizza\s+(\d{4}\/\d{2}\/\d{3,})/i,")
                print("INSERTED_NUM_AT", i + 1)
                break
        else:
            raise SystemExit(f"NUM_LINE_NOT_FOUND {path}")

    # Replace from rcDeclaredOnPage through policyFound block
    text = "\n".join(lines)
    if "htmlPolicyNumberRc" not in text:
        start = None
        end = None
        for i, line in enumerate(lines):
            if line.startswith("  const rcDeclaredOnPage ="):
                start = i
            if start is not None and line.startswith("  const policyFound ="):
                # find end of policyFound assignment (line with expiry));)
                j = i
                while j < len(lines) and "expiry));" not in lines[j]:
                    j += 1
                if j >= len(lines):
                    raise SystemExit("POLICYFOUND_END_NOT_FOUND")
                end = j
                break
        if start is None or end is None:
            raise SystemExit(f"BLOCK_NOT_FOUND start={start} end={end}")

        # detect à char from old block
        block = "\n".join(lines[start : end + 1])
        a_char = "à"
        import re
        mm = re.search(r"responsabilit\[a([^\]]+)\]", block)
        if mm:
            # take first char after a inside the class — usually à
            a_char = mm.group(1)[0]

        new_block = [
            "  const hasRcContext =",
            f"    /polizza\\s+in\\s+vigore|responsabilit[a{a_char}]\\s+civile|\\bR\\.?C\\.?T\\b|\\bR\\.?C\\.?O\\b|art\\.?\\s*10|legge\\s+gelli|copertura\\s+assicurativa|polizza\\s+stipulata|polizza\\s+(?:di\\s+)?assicurazione|numero\\s+(?:della\\s+)?pratica|polizza\\s+n/i.test(",
            "      clean",
            "    );",
            "  // Trasparenza HTML: n. polizza + massimale/compagnia + contesto RC.",
            "  const rcDeclaredOnPage =",
            "    Boolean(policyNumber && (massimale || insurer)) && hasRcContext;",
            "  // Home/footer Art.10: numero + contesto RC anche SENZA compagnia/massimale.",
            '  // Senza questo → falso HOT (es. IATREION "Polizza n. 747217409" in home).',
            "  const htmlPolicyNumberRc = Boolean(policyNumber) && hasRcContext;",
            "  const parmRcDisclosure = isParmRcInsuranceDisclosure(clean) && Boolean(insurer);",
            "",
            "  const rcInsurancePdf =",
            "    Boolean(insurer) &&",
            f"    /responsabilit[a{a_char}]\\s+civile/i.test(clean) &&",
            "    /\\bRCT\\b|\\bRCO\\b|contraente|contratto\\s+n\\.?|quanto\\s+assicuriamo|durata\\s+del\\s+contratto/i.test(",
            "      clean",
            "    );",
            "",
            "  const policyFound =",
            "    concreteData ||",
            "    selfInsured ||",
            "    rcDeclaredOnPage ||",
            "    htmlPolicyNumberRc ||",
            "    parmRcDisclosure ||",
            "    rcInsurancePdf ||",
            "    (appendixPolicy && Boolean(policyNumber && expiry));",
        ]
        lines[start : end + 1] = new_block
        print("REPLACED_BLOCK", start, end, "->", len(new_block), "lines")

    out = nl.join(lines)
    if not out.endswith(nl):
        out += nl
    path.write_bytes(out.encode("utf-8"))
    print("PATCHED_DETECTOR", path)


def patch_pv(path: Path) -> None:
    raw = path.read_bytes()
    nl = "\r\n" if b"\r\n" in raw else "\n"
    s = raw.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
    if "HTML home/footer: numero polizza" in s:
        print("PV_ALREADY", path)
        return
    needle = (
        "  // company + (policyNumber | massimale) + contesto RC → PUBLISHED\n"
        "  if (company && (policyNumber || massimale) && hasRcContext) return true;\n"
    )
    insert = (
        needle
        + "  // HTML home/footer: numero polizza + contesto RC (anche senza compagnia) → PUBLISHED\n"
        + "  // Evita falso HOT tipo IATREION / Galdiero con polizza in chiaro sulla home.\n"
        + "  if (policyNumber && hasRcContext) return true;\n"
    )
    if needle not in s:
        raise SystemExit(f"PV_FAIL {path}")
    s = s.replace(needle, insert, 1)
    path.write_bytes(s.replace("\n", nl).encode("utf-8"))
    print("PATCHED_PV", path)


for p in [
    Path("/opt/leadsniper-revalidate/app/src/lib/sanita/detector.ts"),
    Path("/opt/leadsniper/src/lib/sanita/detector.ts"),
]:
    if p.exists():
        patch_detector(p)

for p in [
    Path("/opt/leadsniper-revalidate/app/src/lib/sanita/policy-verify.ts"),
    Path("/opt/leadsniper/src/lib/sanita/policy-verify.ts"),
]:
    if p.exists():
        patch_pv(p)

print("DONE")
