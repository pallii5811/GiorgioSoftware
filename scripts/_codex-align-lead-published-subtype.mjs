import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/sanita/db-ready.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";
import {
  derivePublishedSubtype,
  stampPublishedSubtype,
} from "../src/lib/sanita/published-subtype.ts";
import { stampProcessingMeta } from "../src/lib/sanita/processing-state.ts";

const ids = process.argv.slice(2);
if (ids.length === 0) throw new Error("at least one lead id is required");
const backupDir = "/opt/leadsniper/backups/lead-subtype-align";
fs.mkdirSync(backupDir, { recursive: true });

for (const id of ids) {
  const lead = await prisma.lead.findUnique({ where: { id } });
  if (!lead) throw new Error(`lead not found: ${id}`);
  if (readVerdictToken(lead.evidence) !== "PUBLISHED" || !lead.policyFound) {
    throw new Error(`lead is not a published policy: ${id}`);
  }
  const subtype = derivePublishedSubtype({
    policyExpiry: lead.policyExpiry,
    policyCompany: lead.policyCompany,
    policyNumber: lead.policyNumber,
    policyMassimale: lead.policyMassimale,
    evidenceBody: lead.evidence,
  });
  if (subtype === "PUBLISHED_STALE_DOCUMENT") {
    throw new Error(`unsupported stale subtype: ${id}`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(
    path.join(backupDir, `${id}-${stamp}.json`),
    JSON.stringify(lead, null, 2),
    "utf8"
  );
  let evidence = stampPublishedSubtype(lead.evidence || "", subtype);
  evidence = stampProcessingMeta(evidence, {
    state: subtype,
    businessVerdict: subtype,
    validationStatus: "CURRENT_VERIFIED",
  });
  await prisma.lead.update({ where: { id }, data: { evidence } });
  console.log(JSON.stringify({ id, companyName: lead.companyName, subtype, policyExpiry: lead.policyExpiry }));
}

await prisma.$disconnect();
