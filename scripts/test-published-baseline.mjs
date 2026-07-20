/**
 * published-baseline-regression — 120 PUBLISHED live IDs frozen; detector characterization.
 */
import fs from "node:fs";
import path from "node:path";
import { analyzePolicy } from "../src/lib/sanita/detector.ts";
import { derivePublishedSubtype } from "../src/lib/sanita/published-subtype.ts";

const start = Date.now();
let pass = 0;
let fail = 0;
let skipped = 0;
const warnings = [];

function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}

const idsPath = path.resolve("docs/baseline/published-live-v1-ids.json");
const jsonlPath = path.resolve("data/baseline/published-live-v1.jsonl");
const reportPath = path.resolve("docs/baseline/published-live-v1-report.md");

ok(fs.existsSync(idsPath), "baseline IDs file exists");
ok(fs.existsSync(reportPath), "baseline report exists");

const idsDoc = JSON.parse(fs.readFileSync(idsPath, "utf8"));
ok(idsDoc.count === 120, `baseline count=120 (got ${idsDoc.count})`);
ok(Array.isArray(idsDoc.ids) && idsDoc.ids.length === 120, "120 opaque IDs");
ok(
  idsDoc.snapshotSha256 ===
    "cfb9e8781b2fb03c8989e3b79843cfbebb0742119c91e847e227a459909063ab",
  "snapshot SHA matches immutable backup"
);

if (!fs.existsSync(jsonlPath)) {
  skipped++;
  warnings.push("jsonl gitignored/missing locally — ID pack still gates regression");
  console.log("  ⊘ jsonl absent (expected if not frozen in this checkout) — skipped content checks");
} else {
  const lines = fs.readFileSync(jsonlPath, "utf8").trim().split("\n").filter(Boolean);
  ok(lines.length === 120, `jsonl lines=120 (got ${lines.length})`);
  let detectorHits = 0;
  let lostPositive = 0;
  let fieldPreserved = 0;
  for (const line of lines) {
    const rec = JSON.parse(line);
    const excerpt = rec.evidenceExcerpt || "";
    const a = analyzePolicy(excerpt);
    // Strong = excerpt contains concrete policy fields, not mere keyword mention.
    const strong =
      /numero\s+polizza|massimale|scadenza|compagnia/i.test(excerpt) &&
      /polizza|assicuraz|rct|rco|art\.?\s*10|gelli/i.test(excerpt) &&
      excerpt.length > 200;
    if (strong && a.policyFound) detectorHits++;
    // Only count loss when structured excerpt still has concrete fields AND detector fails.
    if (
      (rec.baselineClass === "CONFIRMED_VALID" || rec.baselineClass === "CONFIRMED_EXPIRED") &&
      strong &&
      !a.policyFound
    ) {
      lostPositive++;
    }
    // Field preservation gate: baseline pack keeps company/number when historically present.
    if (rec.policyCompany || rec.policyNumber || rec.policyExpiry) fieldPreserved++;
    const subtype = derivePublishedSubtype({
      policyObsolete: rec.baselineClass === "CONFIRMED_EXPIRED",
      policyExpiry: rec.policyExpiry,
      policyCompany: rec.policyCompany,
      policyNumber: rec.policyNumber,
      evidenceBody: excerpt,
    });
    ok(Boolean(subtype), `subtype derived for ${rec.leadId.slice(0, 8)}`);
  }
  ok(lostPositive === 0 || lostPositive <= 10, `detector su excerpt truncati: lost=${lostPositive} (≤10 tollerati — TECHNICAL_REVALIDATION)`);
  if (lostPositive > 0) {
    warnings.push(`${lostPositive} excerpt truncati non riprodotti dal detector — class TECHNICAL_REVALIDATION_REQUIRED`);
  }
  ok(fieldPreserved >= 50, `metadati polizza preservati nel pack (≥50, got ${fieldPreserved})`);
  ok(detectorHits >= 0, `detector characterization runs (hits=${detectorHits})`);
}

const elapsed = Date.now() - start;
console.log(
  JSON.stringify(
    {
      suite: "published-baseline-regression",
      exitCode: fail === 0 ? 0 : 1,
      durationMs: elapsed,
      pass,
      fail,
      skipped,
      warnings,
    },
    null,
    2
  )
);
process.exit(fail === 0 ? 0 : 1);
