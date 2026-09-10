import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";

const jobId = process.argv[2] || "f70c8a92-e783-4fae-9b49-68ec61d1dfe1";
const jobPath = path.join(
  process.cwd(),
  "data",
  "sanita-national-discovery",
  `${jobId}.json`
);

const repaired = await prisma.lead.updateMany({
  where: {
    type: "HEALTHCARE",
    region: "Calabria",
    city: "Crotone",
    evidence: { contains: "frontier store refuses live production paths" },
  },
  data: {
    lastScannedAt: null,
    policyFound: false,
    policyCompany: null,
    policyMassimale: null,
    policyNumber: null,
    policyExpiry: null,
    confidence: null,
    evidence: null,
    websiteReachable: null,
    pagesVisited: 0,
    leadScore: 0,
  },
});

const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
const now = new Date().toISOString();
job.status = "cancelled";
job.pid = null;
job.cancelRequested = true;
job.finishedAt = now;
job.updatedAt = now;
job.progress = {
  ...job.progress,
  structuresScanned: 0,
  certifiedResults: 0,
  currentMunicipality: null,
  message: "Tentativo tecnico annullato e ripulito; pronto per la nuova scansione.",
};
const temporary = `${jobPath}.tmp.${process.pid}`;
fs.writeFileSync(temporary, JSON.stringify(job, null, 2));
fs.renameSync(temporary, jobPath);

console.log(JSON.stringify({ repairedLeads: repaired.count, jobStatus: job.status }));
await prisma.$disconnect();
