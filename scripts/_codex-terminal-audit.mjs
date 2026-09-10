import fs from "node:fs";
import path from "node:path";

const checkpointPath =
  process.env.REVALIDATE_CHECKPOINT ||
  "/opt/leadsniper-revalidate/data/revalidation/checkpoint.json";
const resultsDir =
  process.env.REVALIDATE_RESULTS_DIR ||
  "/opt/leadsniper-revalidate/data/revalidation/results";
const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));

const rows = [];
for (const [id, terminal] of Object.entries(checkpoint.terminal || {})) {
  let result = {};
  try {
    result = JSON.parse(fs.readFileSync(path.join(resultsDir, `${id}.json`), "utf8"));
  } catch {
    // Missing result remains visible in the audit row.
  }
  rows.push({
    id,
    companyName: result.companyName ?? null,
    processingState: terminal.processingState ?? result.processingState ?? null,
    reasonCode: terminal.reasonCode ?? result.reasonCode ?? null,
    policyFound: result.policyFound ?? null,
    policyCompany: result.policyCompany ?? null,
    policyNumber: result.policyNumber ?? null,
    policyExpiry: result.policyExpiry ?? null,
    sourceUrl: result.policyUrl ?? result.website ?? null,
    siteCoverageCertified: result.siteCoverageCertified ?? null,
    crawlComplete: result.crawlComplete ?? null,
    pass1CertifiedAbsence: Boolean(
      result.pass1?.processingState === "HOT_VERIFIED" &&
        result.pass1?.crawlComplete === true &&
        result.pass1?.siteCoverageCertified === true &&
        result.pass1?.negativeIdentityCertified === true
    ),
    pass2CertifiedAbsence: Boolean(
      result.pass2?.processingState === "HOT_VERIFIED" &&
        result.pass2?.crawlComplete === true &&
        result.pass2?.siteCoverageCertified === true &&
        result.pass2?.negativeIdentityCertified === true
    ),
    detectorVersion:
      String(result.fullEvidence || "").match(/policy-candidate-v\d+/i)?.[0] ?? null,
    evidence: String(result.fullEvidence || result.evidence || "").slice(0, 700),
  });
}
console.log(JSON.stringify(rows));
