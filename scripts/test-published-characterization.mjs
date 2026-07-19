/**
 * Characterization — old positive detector keeps recognizing fixture policies.
 */
import fs from "node:fs";
import path from "node:path";
import { analyzePolicy } from "../src/lib/sanita/detector.ts";
import { canEmitPublished, detectInsuranceSignals } from "../src/lib/sanita/can-emit-published.ts";
import { classifyFetchedAgainstFacility } from "../src/lib/sanita/source-class.ts";
import { derivePublishedSubtype } from "../src/lib/sanita/published-subtype.ts";

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

const dir = path.resolve("tests/fixtures/sanita/published-characterization");
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
ok(manifest.fixtures.length >= 4, `fixture count >=4 (got ${manifest.fixtures.length})`);

for (const f of manifest.fixtures) {
  const text = fs.readFileSync(path.join(dir, f.file), "utf8");
  ok(text.length > 40, `${f.id} content present`);
  const a = analyzePolicy(text);
  ok(a.policyFound === f.expectPolicyFound, `${f.id} policyFound=${a.policyFound}`);
  if (f.expectObsolete != null) {
    ok(Boolean(a.policyObsolete) === f.expectObsolete, `${f.id} obsolete=${a.policyObsolete}`);
  }
  const sig = detectInsuranceSignals(text);
  ok(sig.strong || sig.mediumCount >= 2, `${f.id} insurance signals`);
  const url = (text.match(/URL:\s*(\S+)/) || [])[1] || f.facilityWebsite;
  const source = classifyFetchedAgainstFacility({
    pageUrl: url,
    facilityWebsite: f.facilityWebsite,
  });
  ok(source === "FIRST_PARTY_FACILITY", `${f.id} source first-party (got ${source})`);
  const decision = canEmitPublished({
    identityStatus: "OFFICIAL_CONFIRMED",
    sourceClass: source,
    exactUrl: url,
    contentFetched: true,
    contentExcerpt: text.slice(0, 200),
    entityAttributed: true,
    hasStrongInsuranceSignal: sig.strong,
    hasMediumInsuranceSignals: sig.mediumCount,
    policyObsolete: a.policyObsolete,
    hasCoverageEnd: Boolean(a.expiry) || /scadenza/i.test(text),
    analogousMeasure: /autoassicuraz|misura analoga|gestione diretta/i.test(text),
    category: "Casa di cura",
  });
  ok(decision.ok, `${f.id} canEmitPublished (${decision.reasons.join("; ")})`);
  if (decision.businessVerdict) {
    const mapped =
      decision.businessVerdict === "PUBLISHED_ANALOGOUS_MEASURE"
        ? "PUBLISHED_ANALOGOUS_MEASURE"
        : derivePublishedSubtype({
            policyObsolete: a.policyObsolete,
            policyExpiry: a.expiry,
            policyCompany: a.company,
            policyNumber: a.policyNumber,
            analogousMeasure: /autoassicuraz|misura analoga/i.test(text),
            evidenceBody: text,
          });
    ok(
      decision.businessVerdict === f.expectSubtype || mapped === f.expectSubtype,
      `${f.id} subtype expect ${f.expectSubtype} got bv=${decision.businessVerdict} mapped=${mapped}`
    );
  }
}

console.log(
  JSON.stringify(
    {
      suite: "published-characterization",
      exitCode: fail === 0 ? 0 : 1,
      durationMs: Date.now() - start,
      pass,
      fail,
      skipped: 0,
    },
    null,
    2
  )
);
process.exit(fail === 0 ? 0 : 1);
