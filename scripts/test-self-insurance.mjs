/**
 * Regression: autoassicurazione first-party → SELF_INSURANCE_VERIFIED (Malzoni PARS).
 * Non confondere con ANALOGOUS / HOT assenza.
 */
import {
  detectSelfInsuranceDeclaration,
  canEmitSelfInsurance,
  SELF_INSURANCE_UI,
  SELF_INSURANCE_VERIFIED,
} from "../src/lib/sanita/self-insurance.ts";
import { canEmitPublished, detectInsuranceSignals } from "../src/lib/sanita/can-emit-published.ts";
import { derivePublishedSubtype, PUBLISHED_SUBTYPE_META } from "../src/lib/sanita/published-subtype.ts";
import {
  evaluateLeadCompletion,
  isCompletedCommercialState,
} from "../src/lib/sanita/lead-completion.ts";
import { publishedSubtypeOf } from "../src/lib/sanita/archive-results-map.ts";

const start = Date.now();
let pass = 0;
let fail = 0;
function ok(c, m) {
  if (c) {
    pass++;
    console.log(`  ✓ ${m}`);
  } else {
    fail++;
    console.error(`  ✗ ${m}`);
  }
}

const MALZONI_PARS = `
3. Descrizione della posizione assicurativa
Attualmente, la struttura non ha sottoscritto alcuna polizza
assicurativa, ma opera sotto il regime di autoassicurazione.
Malzoni Research Hospital S.p.A. PARS 2026
URL: https://www.malzonicenter.com/trasparenza/PARS_Malzoni-Research-Hospital_2026.pdf
`;

// 1) frase esplicita → detection + SELF_INSURANCE_VERIFIED
const d1 = detectSelfInsuranceDeclaration(
  "opera sotto il regime di autoassicurazione"
);
ok(d1.declared === true, "1. frase regime autoassicurazione → declared");
ok(d1.blocksHotAbsence === true, "1. blocks HOT assenza");

const sig = detectInsuranceSignals(MALZONI_PARS);
const emit = canEmitPublished({
  identityStatus: "OFFICIAL_CONFIRMED",
  sourceClass: "FIRST_PARTY_FACILITY",
  exactUrl: "https://www.malzonicenter.com/trasparenza/PARS_Malzoni-Research-Hospital_2026.pdf",
  contentFetched: true,
  contentExcerpt: MALZONI_PARS,
  entityAttributed: true,
  hasStrongInsuranceSignal: sig.strong,
  hasMediumInsuranceSignals: sig.mediumCount,
  selfInsurance: true,
  analogousMeasure: false,
  category: "Casa di cura",
});
ok(emit.ok && emit.businessVerdict === "SELF_INSURANCE_VERIFIED", "1. canEmit → SELF_INSURANCE_VERIFIED");
ok(
  derivePublishedSubtype({ selfInsurance: true, evidenceBody: MALZONI_PARS }) ===
    "SELF_INSURANCE_VERIFIED",
  "1. derivePublishedSubtype SELF_INSURANCE"
);

// 2) "non ha sottoscritto" + autoassicurazione → non HOT
const d2 = detectSelfInsuranceDeclaration(
  "Attualmente, la struttura non ha sottoscritto alcuna polizza assicurativa, ma opera sotto il regime di autoassicurazione."
);
ok(d2.declared && d2.blocksHotAbsence, "2. no-polizza + autoassicurazione blocks HOT");

// 3) PARS first-party attribuito → terminale commerciale
const gate = canEmitSelfInsurance({
  text: MALZONI_PARS,
  entityAttributed: true,
  firstPartyUrl: true,
  exactUrl: "https://www.malzonicenter.com/trasparenza/PARS_Malzoni-Research-Hospital_2026.pdf",
});
ok(gate.ok, `3. canEmitSelfInsurance (${gate.reasons.join("; ")})`);
const completion = evaluateLeadCompletion({
  identityStatus: "OFFICIAL_CONFIRMED",
  identityConfidence: 1,
  category: "Casa di cura",
  website: "https://www.malzonicenter.com",
  websiteReachable: true,
  pagesVisited: 12,
  policyExhaustive: true,
  needsOcrReview: false,
  crawlCompleteness: {
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
  },
  published: {
    identityStatus: "OFFICIAL_CONFIRMED",
    sourceClass: "FIRST_PARTY_FACILITY",
    exactUrl: "https://www.malzonicenter.com/trasparenza/PARS_Malzoni-Research-Hospital_2026.pdf",
    contentFetched: true,
    contentExcerpt: MALZONI_PARS,
    entityAttributed: true,
    hasStrongInsuranceSignal: true,
    hasMediumInsuranceSignals: 2,
    selfInsurance: true,
    category: "Casa di cura",
  },
  policyDocumentHash: "a".repeat(64),
  policyEvidencePersisted: true,
});
ok(
  completion.complete === true && completion.outcome === "SELF_INSURANCE_VERIFIED",
  "3. evaluateLeadCompletion → SELF_INSURANCE_VERIFIED terminale"
);
ok(isCompletedCommercialState("SELF_INSURANCE_VERIFIED"), "8. completedCommercial include SELF_INSURANCE");

// 4) menzione generica non attribuita → non promuovere
const weak = canEmitSelfInsurance({
  text: "In generale si parla di autoassicurazione nel settore.",
  entityAttributed: false,
  firstPartyUrl: false,
  exactUrl: null,
});
ok(!weak.ok, "4. menzione generica non attribuita → non promuovere");

// 5) documento altra struttura → entityAttributed false
const other = canEmitPublished({
  identityStatus: "OFFICIAL_CONFIRMED",
  sourceClass: "FIRST_PARTY_GROUP",
  exactUrl: "https://www.altrogruppo.it/pars.pdf",
  contentFetched: true,
  contentExcerpt: MALZONI_PARS,
  entityAttributed: false,
  groupSeatVerified: false,
  hasStrongInsuranceSignal: true,
  hasMediumInsuranceSignals: 2,
  selfInsurance: true,
  category: "Casa di cura",
});
ok(!other.ok, "5. altra struttura/gruppo senza attribution → non promuovere");

// 6) UI label
ok(
  SELF_INSURANCE_UI.tableLabel === "Autoassicurazione dichiarata",
  "6. UI label Autoassicurazione dichiarata"
);
ok(
  PUBLISHED_SUBTYPE_META.SELF_INSURANCE_VERIFIED.label === "Autoassicurazione dichiarata",
  "6. subtype meta label"
);
ok(publishedSubtypeOf("SELF_INSURANCE_VERIFIED") === "self_insurance", "6. archive map self_insurance");
ok(SELF_INSURANCE_UI.category === "AUTOASSICURATA", "6. categoria AUTOASSICURATA");
ok(SELF_INSURANCE_UI.filter === SELF_INSURANCE_VERIFIED, "6. filtro SELF_INSURANCE_VERIFIED");

// 7) export / commercial set — SELF in completed; ANALOGOUS out
ok(isCompletedCommercialState("PUBLISHED_CURRENT"), "7. CURRENT commercial");
ok(isCompletedCommercialState("HOT_VERIFIED"), "7. HOT commercial");
ok(!isCompletedCommercialState("PUBLISHED_ANALOGOUS_MEASURE"), "7. ANALOGOUS non commercial");
ok(
  derivePublishedSubtype({
    analogousMeasure: true,
    evidenceBody: "misura analoga alle coperture assicurative",
  }) === "PUBLISHED_ANALOGOUS_MEASURE",
  "7. misura analoga resta ANALOGOUS (non SELF)"
);

// autoassicurazione non deve classificare come ANALOGOUS
ok(
  derivePublishedSubtype({
    selfInsurance: true,
    analogousMeasure: true,
    evidenceBody: MALZONI_PARS,
  }) === "SELF_INSURANCE_VERIFIED",
  "selfInsurance ha priorità su analogousMeasure"
);

console.log(
  JSON.stringify(
    {
      suite: "self-insurance",
      exitCode: fail === 0 ? 0 : 1,
      durationMs: Date.now() - start,
      pass,
      fail,
    },
    null,
    2
  )
);
process.exit(fail === 0 ? 0 : 1);
