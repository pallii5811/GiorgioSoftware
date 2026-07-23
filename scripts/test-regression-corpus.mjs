/**
 * Regression corpus obbligatorio pre-release (gate non negoziabile).
 * Run: npx tsx scripts/test-regression-corpus.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { analyzePolicy } from "../src/lib/sanita/detector.ts";
import {
  canEmitPublished,
  detectInsuranceSignals,
} from "../src/lib/sanita/can-emit-published.ts";
import { derivePublishedSubtype } from "../src/lib/sanita/published-subtype.ts";
import {
  resolveSelfInsuranceSignal,
  SELF_INSURANCE_UI,
} from "../src/lib/sanita/self-insurance.ts";
import {
  evaluateLeadCompletion,
  isCompletedCommercialState,
} from "../src/lib/sanita/lead-completion.ts";
import { PUBLISHED_SUBTYPE_META } from "../src/lib/sanita/published-subtype.ts";

const start = Date.now();
let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function completeFrontier(over = {}) {
  return {
    identityVerified: true,
    sitemapExhausted: true,
    sitemapStatus: "DISCOVERED_COMPLETE",
    htmlQueueExhausted: true,
    relevantLinksProcessed: true,
    relevantDocumentsProcessed: true,
    jsonEndpointsProcessed: true,
    sameHostScriptsProcessed: true,
    unresolvedRelevantUrls: 0,
    failedRelevantUrls: 0,
    unreadableRelevantDocuments: 0,
    criticalOcrDoubts: 0,
    urlCapReached: false,
    timeCapReached: false,
    complete: true,
    ...over,
  };
}

const dir = path.resolve("tests/fixtures/sanita/regression-corpus");
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));

ok(manifest.cases.length >= 15, `corpus size >=15 (got ${manifest.cases.length})`);
ok(
  SELF_INSURANCE_UI.tableLabel === "Autoassicurazione dichiarata",
  "UI label Autoassicurazione dichiarata"
);
ok(isCompletedCommercialState("SELF_INSURANCE_VERIFIED"), "SELF in completedCommercial");
ok(!isCompletedCommercialState("PUBLISHED_ANALOGOUS_MEASURE"), "ANALOGOUS out of commercial");

for (const c of manifest.cases) {
  const text = fs.readFileSync(path.join(dir, c.file), "utf8");
  const url = (text.match(/URL:\s*(\S+)/) || [])[1] || `${c.facilityWebsite}/doc.pdf`;
  const a = analyzePolicy(text, url);
  const si = resolveSelfInsuranceSignal({ text, policyCompany: a.company });
  const sig = detectInsuranceSignals(text);
  const sourceClass = c.sourceClass || "FIRST_PARTY_FACILITY";

  if (c.expect === "SELF_INSURANCE_VERIFIED") {
    ok(si.declared, `${c.id}: detection declared`);
    ok(si.blocksHotAbsence, `${c.id}: blocks HOT`);
    const emit = canEmitPublished({
      identityStatus: "OFFICIAL_CONFIRMED",
      sourceClass,
      exactUrl: url,
      contentFetched: true,
      contentExcerpt: text.slice(0, 2500),
      entityAttributed: c.entityAttributed !== false,
      groupSeatVerified: c.groupSeatVerified === true,
      hasStrongInsuranceSignal: sig.strong || si.declared,
      hasMediumInsuranceSignals: Math.max(sig.mediumCount, si.declared ? 2 : 0),
      selfInsurance: si.declared,
      analogousMeasure: !si.declared && /misura\s+analoga/i.test(text),
      category: "Casa di cura",
    });
    ok(emit.ok, `${c.id}: canEmit (${emit.reasons.join("; ")})`);
    ok(
      emit.businessVerdict === "SELF_INSURANCE_VERIFIED",
      `${c.id}: BV=SELF_INSURANCE_VERIFIED (got ${emit.businessVerdict})`
    );
    ok(
      derivePublishedSubtype({ selfInsurance: true, evidenceBody: text }) ===
        "SELF_INSURANCE_VERIFIED",
      `${c.id}: subtype SELF`
    );
    ok(
      PUBLISHED_SUBTYPE_META.SELF_INSURANCE_VERIFIED.label === "Autoassicurazione dichiarata",
      `${c.id}: UI subtype label`
    );
    const completion = evaluateLeadCompletion({
      identityStatus: "OFFICIAL_CONFIRMED",
      identityConfidence: 1,
      category: "Casa di cura",
      website: c.facilityWebsite,
      websiteReachable: true,
      pagesVisited: 20,
      policyExhaustive: true,
      needsOcrReview: false,
      crawlCompleteness: completeFrontier(),
      published: {
        identityStatus: "OFFICIAL_CONFIRMED",
        sourceClass,
        exactUrl: url,
        contentFetched: true,
        contentExcerpt: text.slice(0, 2500),
        entityAttributed: true,
        groupSeatVerified: c.groupSeatVerified === true,
        hasStrongInsuranceSignal: true,
        hasMediumInsuranceSignals: 2,
        selfInsurance: true,
        category: "Casa di cura",
      },
      policyDocumentHash: "b".repeat(64),
      policyEvidencePersisted: true,
      policyCompany: a.company,
    });
    ok(
      completion.complete && completion.outcome === "SELF_INSURANCE_VERIFIED",
      `${c.id}: commercial terminal SELF`
    );
    continue;
  }

  if (c.expect === "REJECT_ATTRIBUTION") {
    ok(si.declared, `${c.id}: text would declare IF attributed`);
    const emit = canEmitPublished({
      identityStatus: "OFFICIAL_CONFIRMED",
      sourceClass: "FIRST_PARTY_FACILITY",
      exactUrl: url,
      contentFetched: true,
      contentExcerpt: text.slice(0, 2500),
      entityAttributed: false,
      hasStrongInsuranceSignal: true,
      hasMediumInsuranceSignals: 2,
      selfInsurance: true,
      category: "Casa di cura",
    });
    ok(!emit.ok, `${c.id}: reject without attribution`);
    continue;
  }

  if (c.expect === "NOT_SELF_INSURANCE") {
    ok(!si.declared, `${c.id}: must NOT declare self-insurance`);
    ok(
      derivePublishedSubtype({
        selfInsurance: false,
        analogousMeasure: /misura\s+analoga/i.test(text),
        evidenceBody: text,
        policyCompany: a.company,
        policyNumber: a.policyNumber,
        policyExpiry: a.expiry,
      }) !== "SELF_INSURANCE_VERIFIED",
      `${c.id}: subtype ≠ SELF`
    );
    continue;
  }

  if (c.expect === "HOT_ELIGIBLE_SIGNAL") {
    ok(!si.declared, `${c.id}: no self-insurance (HOT path open)`);
    ok(!si.blocksHotAbsence, `${c.id}: does not block HOT`);
    const hot = evaluateLeadCompletion({
      identityStatus: "OFFICIAL_CONFIRMED",
      identityConfidence: 1,
      category: "Casa di cura",
      website: c.facilityWebsite,
      websiteReachable: true,
      pagesVisited: 20,
      policyExhaustive: true,
      needsOcrReview: false,
      crawlCompleteness: completeFrontier(),
      secondPassConfirmed: true,
      published: null,
    });
    ok(hot.complete && hot.outcome === "HOT_VERIFIED", `${c.id}: HOT_VERIFIED with complete frontier`);
    continue;
  }

  if (c.expect === "HOT_BLOCKED_FRONTIER") {
    const blocked = evaluateLeadCompletion({
      identityStatus: "OFFICIAL_CONFIRMED",
      identityConfidence: 1,
      category: "Casa di cura",
      website: c.facilityWebsite,
      websiteReachable: true,
      pagesVisited: 20,
      policyExhaustive: true,
      needsOcrReview: false,
      crawlCompleteness: completeFrontier({ unresolvedRelevantUrls: 1, complete: false }),
      secondPassConfirmed: true,
      published: null,
    });
    ok(!blocked.complete, `${c.id}: HOT blocked when unresolved nodes > 0`);
    ok(blocked.outcome == null, `${c.id}: no commercial outcome`);
    continue;
  }

  // Traditional published subtypes
  const obsolete = c.expect === "PUBLISHED_EXPIRED" || a.policyObsolete;
  const emit = canEmitPublished({
    identityStatus: "OFFICIAL_CONFIRMED",
    sourceClass: "FIRST_PARTY_FACILITY",
    exactUrl: url,
    contentFetched: true,
    contentExcerpt: text.slice(0, 2500),
    entityAttributed: true,
    hasStrongInsuranceSignal: sig.strong,
    hasMediumInsuranceSignals: sig.mediumCount,
    policyObsolete: obsolete || a.policyObsolete,
    hasCoverageEnd: Boolean(a.expiry) || /scadenza/i.test(text),
    selfInsurance: false,
    analogousMeasure: false,
    category: "Casa di cura",
  });
  ok(emit.ok, `${c.id}: canEmit published (${emit.reasons.join("; ")})`);
  const mapped = derivePublishedSubtype({
    policyObsolete: obsolete || a.policyObsolete,
    policyExpiry: a.expiry,
    policyCompany: a.company,
    policyNumber: a.policyNumber,
    policyMassimale: a.massimale,
    evidenceBody: text,
    selfInsurance: false,
  });
  // For CURRENT/EXPIRED prefer evaluateLeadCompletion outcome (uses expiry clock).
  const completion = evaluateLeadCompletion({
    identityStatus: "OFFICIAL_CONFIRMED",
    identityConfidence: 1,
    category: "Casa di cura",
    website: c.facilityWebsite,
    websiteReachable: true,
    pagesVisited: 12,
    policyExhaustive: true,
    needsOcrReview: false,
    crawlCompleteness: completeFrontier(),
    published: {
      identityStatus: "OFFICIAL_CONFIRMED",
      sourceClass: "FIRST_PARTY_FACILITY",
      exactUrl: url,
      contentFetched: true,
      contentExcerpt: text.slice(0, 2500),
      entityAttributed: true,
      hasStrongInsuranceSignal: true,
      hasMediumInsuranceSignals: 2,
      policyObsolete: obsolete || a.policyObsolete,
      hasCoverageEnd: Boolean(a.expiry),
      category: "Casa di cura",
    },
    policyDocumentHash: "c".repeat(64),
    policyEvidencePersisted: true,
    policyCompany: a.company,
    policyNumber: a.policyNumber,
    policyExpiry: a.expiry ? a.expiry.toISOString() : null,
  });
  if (c.expect === "PUBLISHED_DATE_UNKNOWN") {
    ok(
      completion.outcome === "PUBLISHED_DATE_UNKNOWN" ||
        mapped === "PUBLISHED_DATE_UNKNOWN" ||
        emit.businessVerdict === "PUBLISHED_DATE_UNKNOWN",
      `${c.id}: DATE_UNKNOWN`
    );
  } else {
    ok(
      completion.outcome === c.expect || mapped === c.expect || emit.businessVerdict === c.expect,
      `${c.id}: expect ${c.expect} got completion=${completion.outcome} mapped=${mapped} bv=${emit.businessVerdict}`
    );
  }
}

// Explicit anti-regression: old buggy mapping must never win
const malzoni = fs.readFileSync(path.join(dir, "04-self-insurance-explicit.txt"), "utf8");
ok(
  derivePublishedSubtype({
    selfInsurance: resolveSelfInsuranceSignal({ text: malzoni }).declared,
    analogousMeasure: /autoassicuraz|misura analoga|gestione\s+diretta/i.test(malzoni),
    evidenceBody: malzoni,
  }) === "SELF_INSURANCE_VERIFIED",
  "ANTI-REGRESSION: autoassicuraz+gestione diretta → SELF not ANALOGOUS"
);

const report = {
  suite: "regression-corpus",
  exitCode: fail === 0 ? 0 : 1,
  durationMs: Date.now() - start,
  pass,
  fail,
  failures,
  gate: manifest.gate,
};
console.log(JSON.stringify(report, null, 2));
process.exit(fail === 0 ? 0 : 1);
