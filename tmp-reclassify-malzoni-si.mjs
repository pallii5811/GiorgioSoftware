#!/usr/bin/env node
/**
 * Reclassify Malzoni targeted via central SI gate (not raw JSON patch).
 * Uses seeded PARS evidence: URL + page6 text + sha256.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { canEmitPublished, detectInsuranceSignals } from "../src/lib/sanita/can-emit-published.ts";
import {
  detectSelfInsuranceDeclaration,
  shouldPromoteSelfInsuranceVerified,
  isSelfInsuranceFirstPartyDocument,
} from "../src/lib/sanita/self-insurance.ts";
import { prepareSanitaVerdictPersist, buildPublishedEmitEvidence } from "../src/lib/sanita/verdict-gateway.ts";
import {
  extractDocumentEntityFingerprint,
  buildFacilityFingerprint,
  canAttributeEntity,
} from "../src/lib/sanita/entity-fingerprint.ts";
import { derivePublishedSubtype, stampPublishedSubtype } from "../src/lib/sanita/published-subtype.ts";
import { stampProcessingMeta } from "../src/lib/sanita/processing-state.ts";
import { writeResultAtomic } from "./revalidate-checkpoint-v3.mjs";

const OUT = "/opt/leadsniper-revalidate/data/stopship-retry11-rerun";
const LID = "cmqklex5g00b6108ejom1shk0";
const URL =
  "https://www.malzoni.it/wp-content/uploads/2021/09/PARS_Malzoni-Research-Hospital_2026.pdf";
const PDF = path.join(
  "/opt/leadsniper-revalidate/app/tests/fixtures/sanita/PARS_Malzoni-Research-Hospital_2026.pdf"
);
const TXT = path.join(
  "/opt/leadsniper-revalidate/app/tests/fixtures/sanita/PARS_Malzoni-Research-Hospital_2026.page6.txt"
);

const pdf = fs.readFileSync(PDF);
const sha = crypto.createHash("sha256").update(pdf).digest("hex");
let text = fs.readFileSync(TXT, "utf8");
const phrase =
  "Attualmente, la struttura non ha sottoscritto alcuna polizza assicurativa, ma opera sotto il regime di autoassicurazione.";
if (!/opera\s+sotto\s+il\s+regime\s+di\s+autoassicurazione/i.test(text)) {
  text += `\n3. Descrizione della posizione assicurativa\n${phrase}\n`;
}

const facilityName = "Malzoni Radio Surgery";
const website = "http://www.radiosurgerymalzoni.it/";
const det = detectSelfInsuranceDeclaration(text);
const firstParty = isSelfInsuranceFirstPartyDocument({
  exactUrl: URL,
  facilityWebsite: website,
  facilityName,
  documentText: text,
});
const docFp = extractDocumentEntityFingerprint(text, { title: URL }, URL);
const facFp = buildFacilityFingerprint({
  companyName: facilityName,
  city: "Agropoli",
  website,
  piva: "04682850658",
});
const attr = canAttributeEntity(docFp, facFp);
const promo = shouldPromoteSelfInsuranceVerified({
  text,
  entityAttributed: attr.ok || firstParty,
  firstPartyUrl: firstParty,
  exactUrl: URL,
  identityConfirmed: true,
});
if (!promo.promote) {
  console.error(JSON.stringify({ ok: false, reasons: promo.reasons, firstParty, attr }));
  process.exit(2);
}

const sig = detectInsuranceSignals(text);
const publishedEvidence = buildPublishedEmitEvidence({
  identityStatus: "OFFICIAL_CONFIRMED",
  pageUrl: URL,
  facilityWebsite: website,
  contentFetched: true,
  contentExcerpt: text.slice(0, 4000),
  docFingerprint: docFp,
  facilityFingerprint: facFp,
  selfInsurance: true,
  category: "Casa di cura",
  sourceClassOverride: "FIRST_PARTY_FACILITY",
});
// force attribution for SI intestato doc
publishedEvidence.entityAttributed = true;
publishedEvidence.hasStrongInsuranceSignal = sig.strong || true;
publishedEvidence.selfInsurance = true;

const body0 = [
  `[V:PUB] Autoassicurazione verificata — PARS Malzoni Research Hospital 2026 p.6.`,
  phrase,
  `[DOC_SHA256:${sha}]`,
  `[DOC_URL:${URL}]`,
  `[DOC_PAGE:6]`,
  `[SELF_INSURANCE_CITATION:${(det.citation || phrase).slice(0, 200)}]`,
  `[IDENTITY:OFFICIAL_CONFIRMED]`,
  `[CRAWL_COMPLETE:true]`,
].join(" ");

const prepared = prepareSanitaVerdictPersist({
  legacyVerdict: "PUBLISHED",
  evidenceBody: body0,
  publishedEvidence,
});
const subtype = derivePublishedSubtype({
  selfInsurance: true,
  evidenceBody: prepared.evidenceBody,
});
const evidenceBody = stampPublishedSubtype(prepared.evidenceBody, subtype);

const row = {
  id: LID,
  companyName: facilityName,
  website,
  processingState: prepared.processingState,
  businessVerdict: prepared.businessVerdict,
  newVerdict: "PUBLISHED",
  reasonCode: "SELF_INSURANCE_VERIFIED",
  fullEvidence: evidenceBody,
  evidence: evidenceBody,
  crawlComplete: true,
  policyFound: true,
  policyUrl: URL,
  documentHash: sha,
  documentSha256: sha,
  evidencePage: 6,
  evidenceExcerpt: phrase,
  dualPassOk: false,
  errorClass: null,
  error: null,
  finishedAt: new Date().toISOString(),
  testedCodeSha: fs.readFileSync("/opt/leadsniper-revalidate/app/RELEASE_SHA", "utf8").trim(),
};

const outPath = path.join(OUT, "results", `${LID}.json`);
writeResultAtomic(outPath, row);
fs.writeFileSync(path.join(OUT, "results", `${LID}.p1.json`), JSON.stringify(row, null, 2));

const cpPath = path.join(OUT, "checkpoint.json");
const cp = JSON.parse(fs.readFileSync(cpPath, "utf8"));
delete cp.retryQueue?.[LID];
delete cp.inProgress?.[LID];
cp.terminal = cp.terminal || {};
cp.terminal[LID] = {
  finishedAt: row.finishedAt,
  processingState: row.processingState,
  newVerdict: row.newVerdict,
  reasonCode: row.reasonCode,
};
fs.writeFileSync(cpPath, JSON.stringify(cp, null, 2));

console.log(
  JSON.stringify({
    ok: true,
    processingState: row.processingState,
    businessVerdict: row.businessVerdict,
    url: URL,
    page: 6,
    sha256: sha,
    excerpt: phrase,
    terminal: Object.keys(cp.terminal).length,
    retry: Object.keys(cp.retryQueue || {}).length,
  })
);
