/**
 * Document fingerprint + attribution regression (no network).
 */
import {
  extractDocumentEntityFingerprint,
  buildFacilityFingerprint,
  canAttributeEntity,
} from "../src/lib/sanita/entity-fingerprint.ts";
import { classifyNegativeInsuranceDocument } from "../src/lib/sanita/negative-document.ts";

let pass = 0;
let fail = 0;
function ok(c, m) {
  if (c) {
    pass++;
    console.log(`  ✓ ${m}`);
  } else {
    fail++;
    console.error(`  ✗ ${m}`);
  }
}

// Clotilde — name + comune + domain from DOC text (not lead copy)
const clotildeText = `
Polizza RCT/RCO Assicurato: Fondazione Clotilde
Contraente Fondazione Clotilde Roccarainola
Sede legale Via Roma 1, 80030 Roccarainola (NA)
Partita IVA 01234567890 Compagnia UnipolSai numero 1/139602/65/184419847/1
scadenza 31/12/2023 Massimale Euro 5000000
`;
const clotildeUrl = "https://www.fondazioneclotilde.it/wp-content/uploads/2024/12/Assicurazione.pdf";
const docC = extractDocumentEntityFingerprint(clotildeText, { title: "Assicurazione" }, clotildeUrl);
ok(!/lead/i.test(JSON.stringify(docC)), "doc fp has no lead injection marker");
ok(/clotilde/i.test(docC.facilityName || docC.legalName || ""), "Clotilde name extracted from doc");
ok(/roccarainola/i.test(docC.municipality || ""), "Clotilde comune extracted");
const facC = buildFacilityFingerprint({
  companyName: "Fondazione Clotilde",
  city: "Roccarainola",
  website: "http://www.fondazioneclotilde.it/",
  piva: "01234567890",
});
const attrC = canAttributeEntity(docC, facC);
ok(attrC.ok, `Clotilde attributed (${attrC.strongIds}|${attrC.mediumIds})`);

// Same host other entity → reject
const otherDoc = extractDocumentEntityFingerprint(
  "Assicurato: Altra Clinica Spa Comune di Napoli Partita IVA 99999999999",
  null,
  clotildeUrl
);
const attrOther = canAttributeEntity(otherDoc, facC);
ok(!attrOther.ok, "first-party PDF of other entity rejected");

// RC-08 — first-party PARM PDF with no extractable name still attributes via domain+seatPage
const parmDoc = extractDocumentEntityFingerprint(
  "PARM 2025 Piano annuale del rischio. Posizione assicurativa RCT/O Massimale Euro 5000000.",
  { title: "PARM_2025.pdf" },
  "https://villadeipini.com/villadeipini/wp-content/uploads/2025/03/PARM_2025.pdf"
);
const facPini = buildFacilityFingerprint({
  companyName: "Villa Dei Pini Casa di Cura Privata S.p.a.",
  city: "Villamaina",
  website: "https://www.villadeipini.com/site/",
});
const attrParm = canAttributeEntity(parmDoc, facPini);
ok(attrParm.ok && attrParm.mediumIds.includes("domain"), "RC-08 PARM first-party policy PDF attributed");

// CCNL / bilancio
const ccnl = classifyNegativeInsuranceDocument(
  "CCNL ARIS RSA Contratto collettivo nazionale",
  "https://x.it/CCNLarisrsa.pdf"
);
ok(ccnl.blocked && ccnl.kind === "CCNL", "CCNL rejected");
const bil = classifyNegativeInsuranceDocument("Bilancio d'esercizio stato patrimoniale XBRL", "https://x.it/bilancio.pdf");
ok(bil.blocked, "bilancio rejected");

// Group with explicit seats
const groupDoc = extractDocumentEntityFingerprint(
  "Assicurato Gruppo Synergo. Sede di Milano Via X. Sede di Roma Via Y. Gestore: Synergo Spa",
  null,
  "https://www.grupposynergo.com/polizza.pdf"
);
ok(groupDoc.groupSeatVerified === true, "group seats extracted");
const facG = buildFacilityFingerprint({
  companyName: "Gruppo Synergo",
  website: "https://www.grupposynergo.com/",
  groupSeatVerified: true,
  manager: "Synergo Spa",
});
// name + manager may need manager on facility
facG.manager = "Synergo Spa";
const attrG = canAttributeEntity(groupDoc, facG);
ok(attrG.ok || attrG.mediumIds.includes("name"), "group seat path evaluable");

// Group without seats → REVIEW (not auto ok on domain alone)
const thin = extractDocumentEntityFingerprint("pagina generica", null, "https://www.grupposynergo.com/x");
const attrThin = canAttributeEntity(thin, facG);
ok(!attrThin.ok, "domain-only without identity rejected");

// P.IVA only strong match
const vatDoc = extractDocumentEntityFingerprint(
  "Contratto assicurativo RCT Partita IVA 01234567890 massimale Euro 1.000.000",
  null,
  "https://other-host.example/doc.pdf"
);
const attrVat = canAttributeEntity(vatDoc, facC);
ok(attrVat.ok && attrVat.strongIds.includes("vatId"), "P.IVA-only attribution accepted");

// Must not copy facility into doc when empty text
const empty = extractDocumentEntityFingerprint("", null, "https://www.fondazioneclotilde.it/x");
ok(empty.facilityName == null && empty.municipality == null, "empty doc does not inherit facility name/city");

console.log(`\nFingerprint: ${pass} pass, ${fail} fail\n`);
process.exit(fail > 0 ? 1 : 0);
