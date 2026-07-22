import { extractDocumentEntityFingerprint, buildFacilityFingerprint, canAttributeEntity } from "../src/lib/sanita/entity-fingerprint.ts";
import { buildPublishedEmitEvidence } from "../src/lib/sanita/verdict-gateway.ts";
import { canEmitPublished } from "../src/lib/sanita/can-emit-published.ts";

const cases = [
  {
    name: "Pini",
    company: "Villa Dei Pini Casa di Cura Privata S.p.a.",
    city: "Villamaina",
    website: "https://www.villadeipini.com/site/",
    pdf: "https://villadeipini.com/villadeipini/wp-content/uploads/2025/03/PARM_2025.pdf",
    text: "PARM 2025 Piano annuale del rischio. Posizione assicurativa. Auto-assicurazione / gestione diretta del rischio. Massimale Euro 5000000.",
  },
  {
    name: "Montevergine",
    company: "Casa Di Cura Montevergine",
    city: "Solofra",
    website: "http://www.clinicamontevergine.com/",
    pdf: "https://www.clinicamontevergine.com/cuore/wp-content/uploads/2025/06/OBBLIGO-DI-ASSICURAZIONE.pdf",
    text: "Casa di Cura Privata Montevergine S.p.A. polizza N 450289527 Assicurazioni Generali massimale Euro 5.000.000 RCT/O",
  },
];

for (const c of cases) {
  const doc = extractDocumentEntityFingerprint(c.text, { title: c.pdf }, c.pdf);
  const fac = buildFacilityFingerprint({ companyName: c.company, city: c.city, website: c.website });
  const attr = canAttributeEntity(doc, fac);
  const pub = buildPublishedEmitEvidence({
    identityStatus: "OFFICIAL_CONFIRMED",
    pageUrl: c.pdf,
    facilityWebsite: c.website,
    contentFetched: true,
    contentExcerpt: c.text,
    docFingerprint: doc,
    facilityFingerprint: fac,
    category: "casa_di_cura",
  });
  const gate = canEmitPublished(pub);
  console.log(JSON.stringify({
    name: c.name,
    docName: doc.facilityName || doc.legalName,
    facDomain: fac.domain,
    docDomain: doc.domain,
    attr,
    entityAttributed: pub.entityAttributed,
    sourceClass: pub.sourceClass,
    strong: pub.hasStrongInsuranceSignal,
    medium: pub.hasMediumInsuranceSignals,
    gate,
  }, null, 2));
}
