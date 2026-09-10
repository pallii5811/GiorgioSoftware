import path from "node:path";
import { pathToFileURL } from "node:url";

const appDir = process.env.APP_DIR || path.resolve(import.meta.dirname, "..");
const frontierModule = await import(
  pathToFileURL(path.join(appDir, "src/lib/sanita/frontier-store.ts")).href
);
const entityModule = await import(
  pathToFileURL(path.join(appDir, "src/lib/sanita/entity-fingerprint.ts")).href
);
const detectorModule = await import(
  pathToFileURL(path.join(appDir, "src/lib/sanita/detector.ts")).href
);
const {
  aggregatePersistedEvidence,
  closeFrontierStore,
  openFrontierStore,
} = frontierModule;
const {
  buildFacilityFingerprint,
  canAttributeEntity,
  extractPolicyDocumentEntityFingerprint,
} = entityModule;
const { analyzePolicy } = detectorModule;

const frontierPath = process.argv[2];
const runId = process.argv[3];
if (!frontierPath || !runId) throw new Error("frontier path and run id required");

openFrontierStore(frontierPath);
const aggregate = aggregatePersistedEvidence(runId);
closeFrontierStore();
const analysis = analyzePolicy(
  aggregate.policyText || aggregate.pagesText,
  aggregate.policyUrl
);
const document = extractPolicyDocumentEntityFingerprint({
  policyText: aggregate.policyText,
  analysisEvidence: analysis.evidence,
  url: aggregate.policyUrl,
});
const facility = buildFacilityFingerprint({
  companyName: "Villa Fiorita Aversa S.R.L.",
  city: "Villa Literno",
  phone: "081 5032508",
  piva: "00306340613",
  website: "https://clinicavillafiorita.it/",
});
console.log(
  JSON.stringify(
    {
      aggregate: {
        policyFound: aggregate.policyFound,
        policyUrl: aggregate.policyUrl,
        policyTextLength: aggregate.policyText.length,
        policyTextHead: aggregate.policyText.slice(0, 3000),
      },
      analysis: {
        ...analysis,
        expiry: analysis.expiry?.toISOString() ?? null,
      },
      document,
      facility,
      attribution: canAttributeEntity(document, facility),
    },
    null,
    2
  )
);
