import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { stampProcessingMeta } from "@/lib/sanita/processing-state";

const leadId = "cms61uq2y0005thr9o3vjm9dm";
const expectedWrongHost = "madonnadelloscoglio.com";
const officialWebsite = "https://www.sadelmadonnadelloscoglio.com/";
const lead = await prisma.lead.findUnique({ where: { id: leadId } });
if (!lead) throw new Error("Lead Madonna dello Scoglio non trovato");
if (!String(lead.website || "").includes(expectedWrongHost)) {
  throw new Error(`Sito attuale inatteso: ${lead.website || "null"}`);
}

const backupDir = path.join(process.cwd(), "data", "territory-data-fixes");
fs.mkdirSync(backupDir, { recursive: true });
const backupPath = path.join(
  backupDir,
  `madonna-dello-scoglio-before-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
);
fs.writeFileSync(
  backupPath,
  JSON.stringify(
    lead,
    (_, value) => (value instanceof Date ? value.toISOString() : value),
    2
  )
);

const evidence = stampProcessingMeta(
  "Identità corretta: Casa di Cura Madonna dello Scoglio S.r.l., telefono 0962 44188, P.IVA 03328980796, sede Crotone. Sito ufficiale verificato: https://www.sadelmadonnadelloscoglio.com/.",
  {
    state: "CRAWL_RUNNING",
    businessVerdict: "NONE",
    validationStatus: "REVALIDATION_PENDING",
  }
);

const updated = await prisma.lead.update({
  where: { id: leadId },
  data: {
    website: officialWebsite,
    piva: "03328980796",
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
  select: {
    id: true,
    companyName: true,
    website: true,
    phone: true,
    piva: true,
    lastScannedAt: true,
    evidence: true,
  },
});

console.log(JSON.stringify({ backupPath, updated }, null, 2));
await prisma.$disconnect();
