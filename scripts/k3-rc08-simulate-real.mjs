/**
 * Attribution sim with REAL lead fields (shadow DB) + REAL evidence excerpt.
 */
import fs from "node:fs";
import { extractDocumentEntityFingerprint, buildFacilityFingerprint, canAttributeEntity } from "../src/lib/sanita/entity-fingerprint.ts";
import { prisma } from "../src/lib/prisma.ts";

const ids = ["cmqkld5rk009b108ekvol7g87", "cmql4qrif000yc9w74e0tmpqt"];
for (const id of ids) {
  const lead = await prisma.lead.findUnique({ where: { id } });
  const row = JSON.parse(fs.readFileSync(`/opt/leadsniper-revalidate/data/revalidation/results/${id}.json`, "utf8"));
  const ev = row.fullEvidence || "";
  const pdfUrl = (ev.match(/https?:\/\/\S+\.pdf/i) || [null])[0];
  const doc = extractDocumentEntityFingerprint(ev.slice(0, 4000), { title: pdfUrl }, pdfUrl);
  const fac = buildFacilityFingerprint({
    companyName: lead.companyName,
    city: lead.city,
    phone: lead.phone,
    piva: lead.piva,
    website: lead.website,
  });
  const attr = canAttributeEntity(doc, fac);
  console.log(JSON.stringify({
    id,
    company: lead.companyName,
    leadPiva: lead.piva,
    leadWebsite: lead.website,
    pdfUrl,
    docName: doc.facilityName || doc.legalName,
    docVat: doc.vatId,
    docDomain: doc.domain,
    facDomain: fac.domain,
    attr,
  }, null, 1));
}
await prisma.$disconnect();
