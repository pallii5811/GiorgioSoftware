import { prisma } from "../src/lib/sanita/db-ready.ts";
import {
  readNationalDiscoveryJob,
  writeNationalDiscoveryJob,
} from "../src/lib/sanita/national-discovery-jobs.ts";
import { readProcessingState } from "../src/lib/sanita/processing-state.ts";

const jobId = process.argv[2];
if (!jobId) throw new Error("job id required");

const certifiedStates = new Set([
  "HOT_VERIFIED",
  "SELF_INSURANCE_VERIFIED",
  "PUBLISHED_CURRENT",
  "PUBLISHED_EXPIRED",
  "PUBLISHED_DATE_UNKNOWN",
  "PUBLISHED_INCOMPLETE",
  "PUBLISHED_ANALOGOUS_MEASURE",
]);

const job = readNationalDiscoveryJob(jobId);
if (!job) throw new Error(`job not found: ${jobId}`);

const leads = await prisma.lead.findMany({
  where: {
    type: "HEALTHCARE",
    region: job.region,
    ...(job.municipality ? { city: job.municipality } : {}),
  },
  select: { evidence: true, lastScannedAt: true },
});
const structuresScanned = leads.filter((lead) => lead.lastScannedAt).length;
const certifiedResults = leads.filter((lead) =>
  certifiedStates.has(readProcessingState(lead.evidence))
).length;

writeNationalDiscoveryJob({
  ...job,
  progress: {
    ...job.progress,
    structuresFound: leads.length,
    structuresScanned,
    certifiedResults,
  },
});

console.log(JSON.stringify({
  jobId,
  structuresFound: leads.length,
  structuresScanned,
  certifiedResults,
}));
await prisma.$disconnect();
