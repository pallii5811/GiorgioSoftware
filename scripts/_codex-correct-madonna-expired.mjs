#!/usr/bin/env node

import { prisma } from "@/lib/prisma";
import {
  derivePublishedSubtype,
  stampPublishedSubtype,
} from "@/lib/sanita/published-subtype";
import { stampProcessingMeta } from "@/lib/sanita/processing-state";

const id = "cms61uq2y0005thr9o3vjm9dm";
const lead = await prisma.lead.findUnique({ where: { id } });
if (!lead) throw new Error("Lead Madonna dello Scoglio non trovato");
if (!lead.policyFound || !lead.policyExpiry) {
  throw new Error("La polizza certificata e la scadenza devono essere presenti");
}

const subtype = derivePublishedSubtype({
  policyCompany: lead.policyCompany,
  policyNumber: lead.policyNumber,
  policyMassimale: lead.policyMassimale,
  policyExpiry: lead.policyExpiry,
  evidenceBody: lead.evidence,
  now: new Date(),
});
if (subtype !== "PUBLISHED_EXPIRED") {
  throw new Error(`Sottotipo inatteso: ${subtype}`);
}

const compactNumber = (lead.policyNumber || "").replace(/\s+/g, "").toUpperCase();
const normalizedPolicyNumber = /^RCI[0-9O]{8,}$/.test(compactNumber)
  ? `RCI${compactNumber.slice(3).replaceAll("O", "0")}`
  : lead.policyNumber;
if (normalizedPolicyNumber !== "RCI00010000382") {
  throw new Error(`Numero polizza inatteso: ${normalizedPolicyNumber ?? "null"}`);
}

const correctedBody = (lead.evidence || "").replaceAll(
  lead.policyNumber || normalizedPolicyNumber,
  normalizedPolicyNumber
);
const evidence = stampProcessingMeta(
  stampPublishedSubtype(correctedBody, subtype),
  {
    state: subtype,
    businessVerdict: subtype,
    validationStatus: "CURRENT_VERIFIED",
  }
);

const updated = await prisma.lead.update({
  where: { id },
  data: { evidence, policyNumber: normalizedPolicyNumber },
  select: {
    id: true,
    companyName: true,
    website: true,
    policyFound: true,
    policyCompany: true,
    policyNumber: true,
    policyExpiry: true,
    evidence: true,
  },
});

console.log(JSON.stringify({ subtype, updated }, null, 2));
await prisma.$disconnect();
