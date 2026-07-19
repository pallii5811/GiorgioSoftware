/**
 * Static bypass audit — terminal PUB/HOT persist must go through gateway helpers.
 * Fails if scan-engine writes PUBLISHED without prepareSanitaVerdictPersist / buildPublishedEmitEvidence.
 */
import fs from "node:fs";
import path from "node:path";

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

const root = path.resolve("src/lib/sanita");
const scan = fs.readFileSync(path.join(root, "scan-engine.ts"), "utf8");
const gateway = fs.readFileSync(path.join(root, "verdict-gateway.ts"), "utf8");
const canPub = fs.readFileSync(path.join(root, "can-emit-published.ts"), "utf8");
const canHot = fs.readFileSync(path.join(root, "can-emit-hot.ts"), "utf8");

ok(/export function canEmitPublished/.test(canPub), "canEmitPublished exported");
ok(/export function canEmitHot/.test(canHot), "canEmitHot exported");
ok(/export function prepareSanitaVerdictPersist/.test(gateway), "gateway prepareSanitaVerdictPersist");
ok(/buildPublishedEmitEvidence/.test(gateway), "gateway buildPublishedEmitEvidence");

ok(
  /prepareSanitaVerdictPersist\(/.test(scan) && /buildPublishedEmitEvidence\(/.test(scan),
  "scan-engine uses gateway + buildPublishedEmitEvidence"
);
ok(/assertAtomicHotPersist\(/.test(scan), "scan-engine uses assertAtomicHotPersist for HOT");
ok(/buildFrontierFromCrawl\(/.test(scan), "scan-engine stamps CrawlFrontierLedger");

// Candidate proposals in policy-verify are allowed; CURRENT_VERIFIED write must use publishedEvidence
ok(
  /publishedEvidence/.test(scan),
  "PUB persist path supplies publishedEvidence"
);

// Obsolete policy must not become HOT absence in scan-engine recovery block
const obsoleteHotBug =
  /if \(analysis\.policyObsolete\)\s*\{\s*verdict = "HOT"/m.test(scan);
ok(!obsoleteHotBug, "no obsolete→HOT absence bypass in scan-engine");

// Files that may propose PUBLISHED string (not sole writers)
const allowPropose = new Set([
  "policy-verify.ts",
  "verdict.ts",
  "scan-engine.ts",
  "published-subtype.ts",
  "can-emit-published.ts",
  "verdict-gateway.ts",
  "processing-state.ts",
  "discovery-gate.ts",
  "actionable-queue.ts",
]);

const offenders = [];
for (const f of fs.readdirSync(root).filter((x) => x.endsWith(".ts"))) {
  if (allowPropose.has(f)) continue;
  const txt = fs.readFileSync(path.join(root, f), "utf8");
  if (/verdict:\s*"PUBLISHED"|legacyVerdict:\s*"PUBLISHED"/.test(txt)) {
    offenders.push(f);
  }
}
ok(offenders.length === 0, `no unexpected PUBLISHED literals outside allowlist (${offenders.join(",") || "none"})`);

console.log(
  JSON.stringify(
    {
      suite: "bypass-audit",
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
