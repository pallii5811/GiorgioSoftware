import { prisma } from "../src/lib/prisma.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";
import { parseEvidenceSections } from "../src/lib/sanita/audit.ts";

function hasConcrete(l) {
  return Boolean(l.policyMassimale || l.policyNumber || l.policyExpiry);
}

function hasDocPdf(evidence) {
  const p = parseEvidenceSections(evidence);
  const docs = p.docs || [];
  return docs.some((u) => /\.pdf(?:$|\?|#)/i.test(u));
}

const leads = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", lastScannedAt: { not: null } },
  select: {
    id: true,
    companyName: true,
    region: true,
    city: true,
    website: true,
    policyCompany: true,
    policyNumber: true,
    policyExpiry: true,
    policyMassimale: true,
    evidence: true,
  },
});

const pubs = leads.filter((l) => readVerdictToken(l.evidence) === "PUBLISHED");
const suspects = [];

for (const l of pubs) {
  const concrete = hasConcrete(l);
  const docPdf = hasDocPdf(l.evidence);
  // Se è PUBLISHED ma non abbiamo alcun dato concreto e nemmeno PDF linkato → sospetto
  if (!concrete && !docPdf) {
    suspects.push({
      id: l.id,
      companyName: l.companyName,
      region: l.region,
      city: l.city,
      website: l.website,
      policyCompany: l.policyCompany,
      policyNumber: l.policyNumber,
      policyExpiry: l.policyExpiry?.toISOString?.().slice(0, 10) ?? null,
      policyMassimale: l.policyMassimale,
    });
  }
}

console.log(JSON.stringify({ published: pubs.length, suspects: suspects.length }, null, 2));
for (const s of suspects) {
  console.log(
    `${s.companyName} | ${s.region} | ${s.city ?? "-"} | ${s.website ?? "NO_SITE"} | comp:${s.policyCompany ?? "?"} | n:${s.policyNumber ?? "?"} | exp:${s.policyExpiry ?? "?"} | mass:${s.policyMassimale ?? "?"}`
  );
}

await prisma.$disconnect();

