#!/usr/bin/env node

import { prisma } from "@/lib/prisma";
import { stampProcessingMeta } from "@/lib/sanita/processing-state";

const id = "cms61uq2y0005thr9o3vjm9dm";
const website = "https://www.sadelmadonnadelloscoglio.com/";
const current = await prisma.lead.findUnique({ where: { id } });
if (!current) throw new Error("Lead Madonna dello Scoglio non trovato");
if (current.website !== website) {
  throw new Error(`Sito ufficiale inatteso: ${current.website ?? "null"}`);
}

const evidence = stampProcessingMeta(
  "Frontiera contaminata dal precedente dominio omonimo rimossa; nuova scansione esclusiva del sito sanitario ufficiale.",
  {
    state: "CRAWL_RUNNING",
    businessVerdict: "NONE",
    validationStatus: "REVALIDATION_PENDING",
  }
);

const updated = await prisma.lead.update({
  where: { id },
  data: {
    lastScannedAt: null,
    websiteReachable: null,
    pagesVisited: 0,
    policyFound: false,
    policyCompany: null,
    policyNumber: null,
    policyExpiry: null,
    policyMassimale: null,
    confidence: null,
    evidence,
  },
  select: { id: true, companyName: true, website: true, lastScannedAt: true, evidence: true },
});

console.log(JSON.stringify(updated, null, 2));
await prisma.$disconnect();
