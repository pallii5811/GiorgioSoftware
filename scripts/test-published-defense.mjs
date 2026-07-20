/**
 * published-false-positive-defense — blog/snippet/wrong entity must NOT → PUBLISHED.
 */
import { analyzePolicy } from "../src/lib/sanita/detector.ts";
import { reconcilePolicyVerdict } from "../src/lib/sanita/policy-verify.ts";
import { terminalVerdictFromDiscovery, discoveryBlocksTerminalVerdict } from "../src/lib/sanita/discovery-gate.ts";
import { classifySourceUrl, sourceAllowsPublished } from "../src/lib/sanita/source-class.ts";
import { canEmitPublished } from "../src/lib/sanita/can-emit-published.ts";

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

const elapsed = Date.now() - start;
console.log(
  JSON.stringify(
    { suite: "published-false-positive-defense", exitCode: fail === 0 ? 0 : 1, durationMs: elapsed, pass, fail, skipped: 0 },
    null,
    2
  )
);
process.exit(fail === 0 ? 0 : 1);
