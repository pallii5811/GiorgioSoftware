/**
 * Regression: gate host — blocca cross-struttura, permette .it/.com stesso brand.
 * Run: node --experimental-strip-types scripts/test-host-gate.mjs
 */
import { crawlHostMatchesWebsite } from "../src/lib/sanita/site-identity.ts";
import { shouldMergeScanIntoKeeper } from "../src/lib/sanita/lead-dedup-merge.ts";

function crawl(pages, pdf) {
  return {
    ok: true,
    pagesVisited: pages,
    policyPdfUrl: pdf ?? null,
    text: "",
    policyText: "",
  };
}

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else {
    console.log("OK:", msg);
  }
}

// Pini group bug: Rubilli con evidence Villa Dei Pini
const rubilli = crawl(
  ["https://www.villadeipini.com/site/"],
  "https://villadeipini.com/villadeipini/wp-content/uploads/2025/03/PARM_2025.pdf"
);
assert(
  !crawlHostMatchesWebsite("http://www.casadiriposorubilli.it/", rubilli).ok,
  "Rubilli + PDF villadeipini → bloccato"
);

// Villa Dei Pini legittimo
const pini = crawl(
  ["https://www.villadeipini.com/site/"],
  "https://villadeipini.com/villadeipini/wp-content/uploads/2025/03/PARM_2025.pdf"
);
assert(
  crawlHostMatchesWebsite("https://www.villadeipini.com/site/", pini).ok,
  "Villa Dei Pini stesso host → permesso"
);

// TLD gemello stesso brand (regressione alternateBrandTldUrls)
const twin = crawl(["https://www.nepheocare.com/trasparenza"], "https://www.nepheocare.com/polizza.pdf");
assert(
  crawlHostMatchesWebsite("https://www.nepheocare.it/", twin).ok,
  "nepheocare.it Maps + crawl .com → permesso (stesso brand)"
);

// Merge scan: host diversi → no copy
const keeper = {
  id: "k",
  region: "Campania",
  companyName: "Rubilli",
  website: "http://www.casadiriposorubilli.it/",
  lastScannedAt: null,
};
const donor = {
  id: "d",
  region: "Campania",
  companyName: "Pini",
  website: "https://www.villadeipini.com/site/",
  lastScannedAt: new Date(),
  evidence: "[V:PUB] polizza",
  pagesVisited: 102,
};
assert(!shouldMergeScanIntoKeeper(keeper, donor), "merge scan cross-host → rifiutato");

process.exit(failed ? 1 : 0);
