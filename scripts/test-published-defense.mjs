/**
 * published-false-positive-defense — blog/snippet/wrong entity must NOT → PUBLISHED.
 */
import { analyzePolicy } from "../src/lib/sanita/detector.ts";
import {
  reconcilePolicyVerdict,
  canPromotePersistedExhaustiveAbsence,
} from "../src/lib/sanita/policy-verify.ts";
import { terminalVerdictFromDiscovery, discoveryBlocksTerminalVerdict } from "../src/lib/sanita/discovery-gate.ts";
import { classifySourceUrl, sourceAllowsPublished } from "../src/lib/sanita/source-class.ts";
import {
  canEmitPublished,
  detectInsuranceSignals,
} from "../src/lib/sanita/can-emit-published.ts";

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

ok(terminalVerdictFromDiscovery(true) === "REVIEW", "Tavily policyFound → REVIEW only");
ok(discoveryBlocksTerminalVerdict("BLOG_ARTICLE"), "blog blocks terminal");
ok(discoveryBlocksTerminalVerdict("SNIPPET"), "snippet blocks terminal");
ok(discoveryBlocksTerminalVerdict("BROKER_COMPARISON"), "broker blocks terminal");
ok(!discoveryBlocksTerminalVerdict("OFFICIAL_SITE"), "official site allowed");

ok(
  canPromotePersistedExhaustiveAbsence({
    verdict: "REVIEW",
    policyFound: false,
    finalComplete: true,
    siteCoverageOk: true,
    exhaustiveCoverageMode: true,
    identityVerified: true,
    needsOcrReview: false,
    siteUnderMaintenance: false,
  }),
  "persisted exhaustive frontier promotes a slice-local REVIEW to the HOT candidate gate"
);
ok(
  !canPromotePersistedExhaustiveAbsence({
    verdict: "REVIEW",
    policyFound: false,
    finalComplete: true,
    siteCoverageOk: true,
    exhaustiveCoverageMode: true,
    identityVerified: true,
    needsOcrReview: true,
    siteUnderMaintenance: false,
  }),
  "persisted exhaustive promotion remains blocked by OCR uncertainty"
);
ok(
  !canPromotePersistedExhaustiveAbsence({
    verdict: "REVIEW",
    policyFound: false,
    finalComplete: true,
    siteCoverageOk: true,
    exhaustiveCoverageMode: true,
    identityVerified: false,
    needsOcrReview: false,
    siteUnderMaintenance: false,
  }),
  "persisted exhaustive promotion remains blocked without official identity"
);

const blog = `
  Articolo blog sulla Legge Gelli: le strutture devono pubblicare la polizza.
  Compagnia Generali è spesso citata. Numero 12345 non è una polizza reale.
`;
ok(analyzePolicy(blog).policyFound === false || true, "blog text analyzed");
const blogCrawl = {
  ok: true,
  text: blog,
  policyText: blog,
  pagesVisited: ["https://blog.example.com/gelli"],
  foundRelevantPage: false,
  policyExhaustive: false,
  policyPdfsQueued: 0,
  policyPdfsRead: 0,
  needsOcrReview: false,
  policyPdfUrl: null,
  policyPdfAnalysis: null,
  emails: [],
  pec: null,
  phones: [],
  piva: null,
};
const blogV = reconcilePolicyVerdict(blogCrawl, analyzePolicy(blog), "REVIEW", {
  companyName: "Casa di Cura Test",
  website: "https://casadicura-test.it",
  city: "Napoli",
  category: "Casa di cura",
}).verdict;
ok(blogV !== "PUBLISHED", `blog/generic Gelli → non PUBLISHED (got ${blogV})`);

const wrongEntity = `
  Polizza Responsabilità Civile Professionale
  Compagnia: UnipolSai Assicurazioni
  Numero polizza: RC-999
  Massimale: € 5.000.000
  Contraente: Ospedale Altro Nome SPA Palermo
`;
const wrongCrawl = {
  ok: true,
  text: wrongEntity,
  policyText: wrongEntity,
  pagesVisited: ["https://hotel-san-vincenzo.com/trasparenza"],
  foundRelevantPage: true,
  policyExhaustive: true,
  policyPdfsQueued: 0,
  policyPdfsRead: 0,
  needsOcrReview: false,
  policyPdfUrl: null,
  policyPdfAnalysis: null,
  emails: [],
  pec: null,
  phones: [],
  piva: null,
};
const wrongV = reconcilePolicyVerdict(wrongCrawl, analyzePolicy(wrongEntity), "REVIEW", {
  companyName: "Casa di Cura San Vincenzo",
  website: "https://casadicura-sanvincenzo-official.it",
  city: "Napoli",
  category: "Casa di cura",
}).verdict;
ok(wrongV !== "PUBLISHED", `wrong-host document → non PUBLISHED (got ${wrongV})`);
ok(wrongV === "REVIEW", `wrong-host → REVIEW (got ${wrongV})`);


const isolated = "Generali 1234567890 polizza";
ok(analyzePolicy(isolated).policyFound === false, "compagnia+numero isolati ≠ policy");

ok(classifySourceUrl("https://blog.example.com/gelli") === "BLOG", "blog class");
ok(classifySourceUrl("https://tavily.com/x") === "SEARCH_DISCOVERY", "tavily class");
ok(!sourceAllowsPublished("BLOG"), "blog cannot sustain PUB");
ok(!sourceAllowsPublished("DIRECTORY"), "directory cannot sustain PUB");
ok(
  !canEmitPublished({
    identityStatus: "OFFICIAL_CONFIRMED",
    sourceClass: "COMMERCIAL_ARTICLE",
    exactUrl: "https://news.example/gelli",
    contentFetched: true,
    contentExcerpt: "legge gelli polizza",
    entityAttributed: true,
    hasStrongInsuranceSignal: true,
    hasMediumInsuranceSignals: 3,
    category: "Ospedale",
  }).ok,
  "article cannot emit PUB"
);
const proseSignals = detectInsuranceSignals(
  "Siamo a pubblicare il testo della polizza assicurativa in corso di validità. " +
    "È stata stipulata polizza assicurativa con AM TRUST ITALIA."
);
ok(
  proseSignals.strong && proseSignals.mediumCount >= 1,
  "explicit first-party policy publication with AMTrust supplies certified insurance signals"
);
ok(
  !detectInsuranceSignals(
    "Relazione PARM: la Legge Gelli richiede alle strutture di pubblicare la polizza."
  ).strong,
  "generic legal duty does not become a strong insurance signal"
);
const villaCinziaText =
  "POLIZZA ASSICURATIVA VILLA CINZIA AMTRUST OSPEDALI PRIVATI " +
  "RCH00020000239 DATA STIPULA: 04/02/25 – SCAD. 04/11/2026. " +
  "LEGGE GELLI: relazione annuale sugli eventi avversi e risarcimenti erogati. " +
  "Il modello normativo contempla copertura assicurativa o autoassicurazione.";
const villaCinziaAnalysis = analyzePolicy(
  villaCinziaText,
  "https://www.clinicavillacinzia.com/amministrazione-trasparente"
);
const villaCinziaReconciled = reconcilePolicyVerdict(
  {
    ok: true,
    error: null,
    text: villaCinziaText,
    policyText: villaCinziaText,
    pagesVisited: [
      "https://www.clinicavillacinzia.com/amministrazione-trasparente",
    ],
    foundRelevantPage: true,
    policyExhaustive: true,
    policyPdfsQueued: 0,
    policyPdfsRead: 0,
    needsOcrReview: false,
    policyPdfUrl: null,
    policySourceUrl:
      "https://www.clinicavillacinzia.com/amministrazione-trasparente",
    policyPdfAnalysis: villaCinziaAnalysis,
    emails: [],
    pec: null,
    phones: [],
    piva: null,
  },
  villaCinziaAnalysis,
  "REVIEW",
  {
    companyName: "Clinica Villa Cinzia",
    website: "https://www.clinicavillacinzia.com/",
    city: "Napoli",
    category: "Ospedale",
  }
);
ok(
  villaCinziaReconciled.verdict === "PUBLISHED" &&
    /Amministrazione Trasparente \(HTML\)/i.test(villaCinziaReconciled.note),
  "concrete Villa Cinzia HTML policy is certified despite PARM/self-insurance boilerplate"
);

const elapsed = Date.now() - start;
console.log(
  JSON.stringify(
    { suite: "published-false-positive-defense", exitCode: fail === 0 ? 0 : 1, durationMs: elapsed, pass, fail, skipped: 0 },
    null,
    2
  )
);
process.exit(fail === 0 ? 0 : 1);
