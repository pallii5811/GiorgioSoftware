/**
 * ux-consistency — no "in regola"+scaduta; PUB without evidence link; HOT incomplete; HIGH gare no date; stima≠fatto
 */
import { VERDICT_META } from "../src/lib/sanita/verdict.ts";
import {
  derivePublishedSubtype,
  uxLabelForPublished,
  publishedAllowsInRegolaBadge,
  stampPublishedSubtype,
} from "../src/lib/sanita/published-subtype.ts";
import { canEmitHot } from "../src/lib/sanita/can-emit-hot.ts";
import { deriveCrawlComplete } from "../src/lib/evidence/contract.ts";
import { evaluateGareActionable } from "../src/lib/gare/actionable-gate.ts";
import { estimateCauzione, claimKindLabel } from "../src/lib/gare/commercial.ts";
import { isHotPublishedExpiredEvidence } from "../src/lib/sanita/audit.ts";

const start = Date.now();
let pass = 0;
let fail = 0;

function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}

ok(!/in regola/i.test(VERDICT_META.PUBLISHED.label), "VERDICT_META.PUBLISHED senza 'in regola'");

const expired = derivePublishedSubtype({ policyObsolete: true, policyCompany: "Generali", policyExpiry: new Date("2016-01-01") });
ok(expired === "PUBLISHED_EXPIRED", "subtype EXPIRED");
const label = uxLabelForPublished(expired, VERDICT_META.PUBLISHED.label);
ok(/scaduta/i.test(label), "label scaduta");
ok(!/in regola/i.test(label), "scaduta ≠ in regola");
ok(label === "Polizza pubblicata ma scaduta", "exact expired badge label");
ok(VERDICT_META.HOT.label === "Assenza verificata", "HOT badge");
ok(VERDICT_META.REVIEW.label === "Da verificare", "REVIEW badge");
ok(!publishedAllowsInRegolaBadge(expired), "expired non permette badge in regola");

const stamped = stampPublishedSubtype("corpo", "PUBLISHED_EXPIRED");
ok(isHotPublishedExpiredEvidence(`[V:PUB] ${stamped}`), "PUB+EXPIRED riconosciuto UI helper");

ok(
  !canEmitHot({
    website: "https://x.it",
    websiteReachable: true,
    pagesVisited: 20,
    policyExhaustive: true,
    needsOcrReview: false,
    crawlCompleteness: deriveCrawlComplete({
      identityVerified: true,
      sitemapStatus: "DISCOVERED_PARTIAL",
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
    }),
    identityStatus: "OFFICIAL_CONFIRMED",
    category: "RSA",
  }),
  "HOT incompleto bloccato"
);

ok(
  !evaluateGareActionable({
    awardDate: null,
    amount: 9e6,
    hasPhone: true,
    hasEmail: true,
    hasWebsite: true,
    relevance: "HIGH",
    winnerIdentified: true,
    officialSource: true,
    cig: "CIG",
  }).actionable,
  "HIGH Gare senza data non actionable"
);

const est = estimateCauzione(100);
ok(est.kind === "ESTIMATE", "stima non FACT");
ok(!/verificato|fatto/i.test(claimKindLabel(est.kind)), "label stima ≠ fatto");

const elapsed = Date.now() - start;
console.log(
  JSON.stringify(
    { suite: "ux-consistency", exitCode: fail === 0 ? 0 : 1, durationMs: elapsed, pass, fail, skipped: 0 },
    null,
    2
  )
);
process.exit(fail === 0 ? 0 : 1);
